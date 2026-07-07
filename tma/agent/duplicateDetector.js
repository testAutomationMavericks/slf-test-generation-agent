import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const AUTO_DELETE_THRESHOLD = parseFloat(process.env.KB_AUTO_DELETE_THRESHOLD || '0.97')
const FLAG_THRESHOLD        = parseFloat(process.env.KB_FLAG_THRESHOLD        || '0.90')

/**
 * Run after every new KB write.
 * Detects duplicates, auto-deletes near-identical older entries,
 * flags probable duplicates, and posts a Jira comment.
 */
export async function detectAndHandleDuplicates(newEntry, jiraIssueKey) {
  console.log(`\n  Running duplicate check for "${newEntry.title}"...`)

  const projectKey = newEntry.metadata?.project_key || null

  const res = await db.query(
    `SELECT * FROM find_duplicates($1::vector, $2::text, $3, $4::text)`,
    [JSON.stringify(newEntry.embedding), newEntry.id, FLAG_THRESHOLD, projectKey]
  )

  const candidates = res.rows
  if (candidates.length === 0) {
    console.log('  No duplicates found.')
    return
  }

  console.log(`  Found ${candidates.length} candidate(s)`)

  const autoDeleted = []
  const flagged     = []

  for (const candidate of candidates) {
    const sim = parseFloat(candidate.similarity)

    if (sim >= AUTO_DELETE_THRESHOLD) {
      // Near-identical — auto-delete the older one, keep the new one
      await db.query(`DELETE FROM kb_documents WHERE id = $1`, [candidate.id])

      await db.query(`
        INSERT INTO duplicate_log
          (new_entry_id, old_entry_id, old_entry_title, similarity, action_taken)
        VALUES ($1, $2, $3, $4, 'auto_deleted')
      `, [newEntry.id, candidate.id, candidate.title, sim])

      autoDeleted.push(candidate)
      console.log(`  Auto-deleted: "${candidate.title}" (${(sim * 100).toFixed(1)}% similar)`)

    } else {
      // Probable duplicate — flag the older one as outdated
      await db.query(`
        UPDATE kb_documents
        SET    outdated        = true,
               outdated_reason = $1,
               outdated_at     = NOW(),
               duplicate_of    = $2
        WHERE  id = $3
      `, [
        `Possible duplicate of "${newEntry.title}" added in ${newEntry.metadata?.sprint || newEntry.sprint || 'latest sprint'}`,
        newEntry.id,
        candidate.id
      ])

      await db.query(`
        INSERT INTO duplicate_log
          (new_entry_id, old_entry_id, old_entry_title, similarity, action_taken)
        VALUES ($1, $2, $3, $4, 'flagged')
      `, [newEntry.id, candidate.id, candidate.title, sim])

      flagged.push(candidate)
      console.log(`  Flagged: "${candidate.title}" (${(sim * 100).toFixed(1)}% similar)`)
    }
  }

  if (autoDeleted.length > 0 || flagged.length > 0) {
    await postDuplicateWarningToJira({ jiraIssueKey, newEntry, autoDeleted, flagged })

    await db.query(`
      UPDATE duplicate_log SET jira_notified = true WHERE new_entry_id = $1
    `, [newEntry.id])
  }
}

async function postDuplicateWarningToJira({ jiraIssueKey, newEntry, autoDeleted, flagged }) {
  const sprint = newEntry.metadata?.sprint || newEntry.sprint || 'latest sprint'

  const lines = [
    `⚠️ *Duplicate test cases detected by TMA*\n`,
    `New test case added to KB: *${newEntry.title}* (${sprint})\n`
  ]

  if (autoDeleted.length > 0) {
    lines.push(`*Automatically removed from KB* (similarity ≥ ${(AUTO_DELETE_THRESHOLD * 100).toFixed(0)}%):`)
    autoDeleted.forEach(d => {
      lines.push(
        `  • "${d.title}" from ${d.sprint || 'unknown sprint'}` +
        ` — ${(parseFloat(d.similarity) * 100).toFixed(1)}% similar` +
        `${d.zephyr_key ? ` | Zephyr: *${d.zephyr_key}*` : ''}`
      )
    })
    lines.push(``)
    lines.push(`*⚡ Action required in Zephyr Scale:*`)
    autoDeleted.forEach(d => {
      if (d.zephyr_key) {
        lines.push(`  • Please *archive or delete* test case *${d.zephyr_key}* in Zephyr Scale`)
        lines.push(`    It has been superseded by the new test case in ${sprint}`)
      }
    })
    lines.push(``)
  }

  if (flagged.length > 0) {
    lines.push(`*Flagged for manual review* (similarity ${(FLAG_THRESHOLD * 100).toFixed(0)}%–${(AUTO_DELETE_THRESHOLD * 100).toFixed(0)}%):`)
    flagged.forEach(f => {
      lines.push(
        `  • "${f.title}" from ${f.sprint || 'unknown sprint'}` +
        ` — ${(parseFloat(f.similarity) * 100).toFixed(1)}% similar` +
        `${f.zephyr_key ? ` | Zephyr: *${f.zephyr_key}*` : ''}`
      )
    })
    lines.push(``)
    lines.push(`*⚡ Action required:*`)
    lines.push(`  1. Review both test cases in Zephyr Scale`)
    lines.push(`  2. Decide which to keep (usually the newer one)`)
    lines.push(`  3. Archive the older one in Zephyr Scale manually`)
    lines.push(`  4. Run npm run kb → Delete entry to remove from KB if still present`)
  }

  lines.push(`---`)
  lines.push(`_Detected by TMA duplicate detection | Thresholds: auto-delete ≥ ${(AUTO_DELETE_THRESHOLD * 100).toFixed(0)}%, flag ≥ ${(FLAG_THRESHOLD * 100).toFixed(0)}%_`)

  const commentBody = lines.join('\n')

  const auth = Buffer.from(
    `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
  ).toString('base64')

  const res = await fetch(
    `${process.env.JIRA_URL}/rest/api/3/issue/${jiraIssueKey}/comment`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${auth}`,
        Accept:         'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: commentBody.split('\n').map(line => ({
            type: 'paragraph',
            content: [{ type: 'text', text: line }]
          }))
        }
      })
    }
  )

  if (res.ok) {
    console.log(`  ✓ Jira comment posted on ${jiraIssueKey}`)
  } else {
    const body = await res.text().catch(() => '')
    console.warn(`  ⚠ Failed to post Jira comment: ${res.status} ${body.slice(0, 200)}`)
  }
}
