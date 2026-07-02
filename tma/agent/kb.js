import pg from 'pg'
import dotenv from 'dotenv'
import { detectAndHandleDuplicates } from './duplicateDetector.js'
dotenv.config()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

/**
 * Generate a voyage-3 embedding via the Anthropic API.
 * Uses fetch directly — the Anthropic SDK v0.39 does not expose .embeddings.
 */
export async function embed(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const res = await fetch('https://api.anthropic.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'voyage-3',
      input:      text.slice(0, 8000),
      input_type: 'document',
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Voyage-3 embedding failed: ${res.status} ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.data[0].embedding
}

/**
 * Retrieve top-K KB entries semantically similar to the query.
 * Skips entries flagged as outdated.
 */
export async function retrieveKB(query, topK = 8) {
  const embedding = await embed(query)

  const res = await db.query(`
    SELECT
      id, title, feature, sprint, steps, zephyr_key, tags,
      outdated, outdated_reason,
      1 - (embedding <=> $1::vector) AS similarity
    FROM   test_knowledge
    WHERE  outdated = false
    ORDER  BY embedding <=> $1::vector
    LIMIT  $2
  `, [JSON.stringify(embedding), topK])

  // Warn if any high-similarity result was skipped due to being outdated
  const outdatedCheck = await db.query(`
    SELECT title, outdated_reason, 1 - (embedding <=> $1::vector) AS similarity
    FROM   test_knowledge
    WHERE  outdated = true
      AND  1 - (embedding <=> $1::vector) > 0.85
    ORDER  BY similarity DESC
    LIMIT  3
  `, [JSON.stringify(embedding)])

  if (outdatedCheck.rows.length > 0) {
    console.warn(`  ⚠️  Skipped ${outdatedCheck.rows.length} outdated KB entries similar to your query:`)
    outdatedCheck.rows.forEach(r =>
      console.warn(`     "${r.title}" — ${r.outdated_reason}`)
    )
  }

  return res.rows
}

/**
 * Write an approved test to the KB and run duplicate detection.
 */
export async function writeToKB(approvedTest, jiraIssueKey) {
  const steps = approvedTest.steps || []

  const textToEmbed = [
    approvedTest.title,
    approvedTest.objective || '',
    steps.map(s => `${s.action || ''} ${s.expectedResult || ''}`).join(' ')
  ].join(' ').trim()

  const embedding = await embed(textToEmbed)

  const res = await db.query(`
    INSERT INTO test_knowledge (
      title, objective, feature, component, sprint,
      test_type, jira_key, zephyr_key, steps,
      tags, embedding, approved_by, approved_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11::vector, $12, NOW()
    )
    RETURNING id
  `, [
    approvedTest.title,
    approvedTest.objective   || null,
    approvedTest.feature,
    approvedTest.component   || null,
    approvedTest.sprint      || null,
    approvedTest.testType    || 'functional',
    approvedTest.jiraKey     || null,
    approvedTest.zephyrKey   || null,
    JSON.stringify(steps),
    approvedTest.tags        || [],
    JSON.stringify(embedding),
    approvedTest.approvedBy  || 'system'
  ])

  const newEntryId = res.rows[0].id
  const newEntry   = { ...approvedTest, id: newEntryId, embedding }

  console.log(`  ✓ Written to KB: "${approvedTest.title}" (id: ${newEntryId})`)

  await detectAndHandleDuplicates(newEntry, jiraIssueKey)

  return newEntry
}
