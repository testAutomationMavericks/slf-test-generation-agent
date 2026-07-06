import { input, select, confirm } from '@inquirer/prompts'
import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

console.log('\n  TMA KB Manager')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const action = await select({
  message: 'What would you like to do?',
  choices: [
    { name: 'View KB stats',                  value: 'stats'   },
    { name: 'Search KB entries',              value: 'search'  },
    { name: 'View outdated / stale entries',  value: 'stale'   },
    { name: 'View duplicate log',             value: 'duplog'  },
    { name: 'Flag entry as outdated',         value: 'flag'    },
    { name: 'Delete entry',                   value: 'delete'  },
    { name: 'Delete all for a feature',       value: 'purge'   },
    { name: 'Run duplicate scan on full KB',  value: 'scan'    },
    { name: 'Exit',                           value: 'exit'    }
  ]
})

if (action === 'exit') { await db.end(); process.exit(0) }

// ── Stats ──────────────────────────────────────────────────────────────────
if (action === 'stats') {
  const res = await db.query(`SELECT * FROM kb_stats`)
  const s   = res.rows[0]
  console.log(`\n  Total entries:      ${s.total_entries}`)
  console.log(`  Active entries:     ${s.active_entries}`)
  console.log(`  Outdated entries:   ${s.outdated_entries}`)
  console.log(`  Added this month:   ${s.added_this_month}`)
  console.log(`  Added this week:    ${s.added_this_week}`)
  console.log(`  Unique features:    ${s.unique_features}`)
  console.log(`  Unique sprints:     ${s.unique_sprints}`)
  console.log(`  Oldest entry:       ${s.oldest_entry?.toDateString() || 'N/A'}`)
  console.log(`  Last updated:       ${s.last_updated?.toDateString() || 'N/A'}\n`)
}

// ── Search ─────────────────────────────────────────────────────────────────
if (action === 'search') {
  const query      = await input({ message: 'Search term (title / feature / zephyr key):' })
  const projectRaw = await input({ message: 'Filter by project key (leave blank for all):' })
  const project    = projectRaw.trim().toUpperCase() || null

  const res = await db.query(`
    SELECT id,
           metadata->>'title'        AS title,
           metadata->>'feature_area' AS feature,
           metadata->>'sprint'       AS sprint,
           metadata->>'zephyr_key'   AS zephyr_key,
           metadata->>'project_key'  AS project_key,
           outdated,
           created_at
    FROM   kb_documents
    WHERE  (metadata->>'title'        ILIKE $1
         OR metadata->>'feature_area' ILIKE $1
         OR metadata->>'zephyr_key'   ILIKE $1)
      AND  ($2::text IS NULL OR metadata->>'project_key' = $2)
    ORDER  BY created_at DESC
    LIMIT  20
  `, [`%${query}%`, project])

  if (res.rows.length === 0) {
    console.log('\n  No matches found.')
  } else {
    console.log(`\n  ${res.rows.length} result(s):\n`)
    res.rows.forEach(r => {
      const flag = r.outdated ? '  ⚠️  OUTDATED' : ''
      console.log(`  [${r.project_key || '?'}] [${r.feature}] ${r.title}`)
      console.log(`    Sprint: ${r.sprint || 'N/A'}  |  Zephyr: ${r.zephyr_key || 'N/A'}  |  Created: ${r.created_at.toDateString()}${flag}\n`)
    })
  }
}

// ── Stale entries ──────────────────────────────────────────────────────────
if (action === 'stale') {
  const res = await db.query(`SELECT * FROM stale_entries LIMIT 30`)
  if (res.rows.length === 0) {
    console.log('\n  No stale or outdated entries found.')
  } else {
    console.log(`\n  ${res.rows.length} stale/outdated entries:\n`)
    res.rows.forEach(r => {
      console.log(`  [${r.feature}] ${r.title}`)
      console.log(`    Zephyr: ${r.zephyr_key || 'N/A'}  |  Last updated: ${r.updated_at?.toDateString()}`)
      if (r.outdated_reason) console.log(`    Reason: ${r.outdated_reason}`)
      console.log()
    })
  }
}

// ── Duplicate log ──────────────────────────────────────────────────────────
if (action === 'duplog') {
  const res = await db.query(`
    SELECT old_entry_title, similarity, action_taken, jira_notified, created_at
    FROM   duplicate_log
    ORDER  BY created_at DESC
    LIMIT  20
  `)
  if (res.rows.length === 0) {
    console.log('\n  No duplicate detections recorded yet.')
  } else {
    console.log(`\n  Last ${res.rows.length} duplicate detections:\n`)
    res.rows.forEach(r => {
      const notified = r.jira_notified ? '✓ Jira notified' : '✗ Jira not notified'
      console.log(`  [${r.action_taken.toUpperCase()}] "${r.old_entry_title}"`)
      console.log(`    Similarity: ${(r.similarity * 100).toFixed(1)}%  |  ${notified}  |  ${r.created_at.toDateString()}\n`)
    })
  }
}

// ── Flag as outdated ───────────────────────────────────────────────────────
if (action === 'flag') {
  const query = await input({ message: 'Feature or title to search:' })
  const res   = await db.query(`
    SELECT id,
           metadata->>'title'        AS title,
           metadata->>'feature_area' AS feature,
           metadata->>'sprint'       AS sprint,
           metadata->>'zephyr_key'   AS zephyr_key
    FROM   kb_documents
    WHERE  metadata->>'title'        ILIKE $1
        OR metadata->>'feature_area' ILIKE $1
    LIMIT  10
  `, [`%${query}%`])

  if (res.rows.length === 0) { console.log('\n  No matches.'); await db.end(); process.exit(0) }

  const id = await select({
    message: 'Which entry to flag as outdated?',
    choices: res.rows.map(r => ({
      name:  `[${r.feature}] ${r.title} (${r.sprint || 'no sprint'}) ${r.zephyr_key ? '| ' + r.zephyr_key : ''}`,
      value: r.id
    }))
  })

  const reason = await input({
    message: 'Reason (e.g. "Login renamed to Sign In in sprint 5"):',
    validate: v => v.trim() ? true : 'Reason is required'
  })

  await db.query(`
    UPDATE kb_documents
    SET    outdated        = true,
           outdated_reason = $1,
           outdated_at     = NOW()
    WHERE  id = $2
  `, [reason, id])

  console.log('\n  ✓ Entry flagged as outdated.')
  console.log('    Claude will skip this entry in all future KB retrievals.')
  console.log('    Remember to archive the corresponding test in Zephyr Scale manually.\n')
}

// ── Delete entry ───────────────────────────────────────────────────────────
if (action === 'delete') {
  const query = await input({ message: 'Feature or title to search:' })
  const res   = await db.query(`
    SELECT id,
           metadata->>'title'        AS title,
           metadata->>'feature_area' AS feature,
           metadata->>'sprint'       AS sprint,
           metadata->>'zephyr_key'   AS zephyr_key,
           outdated
    FROM   kb_documents
    WHERE  metadata->>'title'        ILIKE $1
        OR metadata->>'feature_area' ILIKE $1
    LIMIT  10
  `, [`%${query}%`])

  if (res.rows.length === 0) { console.log('\n  No matches.'); await db.end(); process.exit(0) }

  const id = await select({
    message: 'Which entry to permanently delete?',
    choices: res.rows.map(r => ({
      name:  `[${r.feature}] ${r.title} (${r.sprint || 'no sprint'}) ${r.zephyr_key ? '| ' + r.zephyr_key : ''}${r.outdated ? ' ⚠️ outdated' : ''}`,
      value: r.id
    }))
  })

  const ok = await confirm({
    message: 'Permanently delete this entry from KB? This cannot be undone.',
    default: false
  })

  if (!ok) { console.log('\n  Cancelled.\n'); await db.end(); process.exit(0) }

  await db.query(`DELETE FROM kb_documents WHERE id = $1`, [id])
  console.log('\n  ✓ Entry permanently deleted from KB.')
  console.log('    Remember to archive the test in Zephyr Scale manually.\n')
}

// ── Purge feature ──────────────────────────────────────────────────────────
if (action === 'purge') {
  const feature = await input({
    message: 'Feature name to purge all entries for (e.g. legacy-checkout):',
    validate: v => v.trim() ? true : 'Required'
  })

  const countRes = await db.query(
    `SELECT COUNT(*) AS count FROM kb_documents WHERE metadata->>'feature_area' ILIKE $1`,
    [`%${feature}%`]
  )
  const count = parseInt(countRes.rows[0].count)

  if (count === 0) { console.log('\n  No entries found for that feature.\n'); await db.end(); process.exit(0) }

  const ok = await confirm({
    message: `Permanently delete ALL ${count} entries for "${feature}"? This cannot be undone.`,
    default: false
  })

  if (!ok) { console.log('\n  Cancelled.\n'); await db.end(); process.exit(0) }

  await db.query(`DELETE FROM kb_documents WHERE metadata->>'feature_area' ILIKE $1`, [`%${feature}%`])
  console.log(`\n  ✓ Deleted ${count} entries for "${feature}" from KB.`)
  console.log('    Remember to archive corresponding tests in Zephyr Scale manually.\n')
}

// ── Full KB duplicate scan ─────────────────────────────────────────────────
if (action === 'scan') {
  const projectRaw = await input({ message: 'Limit scan to project key (leave blank for all):' })
  const project    = projectRaw.trim().toUpperCase() || null

  const ok = await confirm({
    message: project
      ? `Scan project ${project} for duplicates?`
      : 'Scan entire KB for duplicates? This may take a few minutes.',
    default: true
  })
  if (!ok) { await db.end(); process.exit(0) }

  const all = await db.query(`
    SELECT id,
           metadata->>'title'       AS title,
           metadata->>'sprint'      AS sprint,
           metadata->>'project_key' AS project_key
    FROM   kb_documents
    WHERE  (outdated IS NULL OR outdated = false)
      AND  embedding IS NOT NULL
      AND  ($1::text IS NULL OR metadata->>'project_key' = $1)
  `, [project])
  console.log(`\n  Scanning ${all.rows.length} active entries...\n`)

  let duplicatesFound = 0

  for (const entry of all.rows) {
    const dupes = await db.query(
      `SELECT * FROM find_duplicates(
         (SELECT embedding FROM kb_documents WHERE id = $1),
         $1::text,
         0.90,
         $2::text
       )`,
      [entry.id, entry.project_key || null]
    )
    if (dupes.rows.length > 0) {
      duplicatesFound++
      console.log(`  ⚠️  [${entry.project_key || '?'}] "${entry.title}" (${entry.sprint || 'no sprint'})`)
      dupes.rows.forEach(d =>
        console.log(`       → similar to: "${d.title}" — ${(parseFloat(d.similarity) * 100).toFixed(1)}%`)
      )
    }
  }

  if (duplicatesFound === 0) {
    console.log('  ✓ No duplicates found.\n')
  } else {
    console.log(`\n  Found ${duplicatesFound} entries with potential duplicates.`)
    console.log('  Run "Flag entry as outdated" or "Delete entry" to clean them up.\n')
  }
}

await db.end()
