import pg from 'pg'
import { randomUUID } from 'crypto'
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
 * Pass projectKey to scope results to a single Jira project (recommended).
 * Skips entries flagged as outdated.
 */
export async function retrieveKB(query, topK = 8, projectKey = null) {
  const embedding = await embed(query)

  const res = await db.query(`
    SELECT
      id,
      content,
      metadata->>'title'        AS title,
      metadata->>'feature_area' AS feature,
      metadata->>'sprint'       AS sprint,
      metadata->'steps'         AS steps,
      metadata->>'zephyr_key'   AS zephyr_key,
      metadata->'tags'          AS tags,
      metadata->>'approved_by'  AS approved_by,
      outdated,
      outdated_reason,
      1 - (embedding <=> $1::vector) AS similarity
    FROM   kb_documents
    WHERE  (outdated IS NULL OR outdated = false)
      AND  ($3::text IS NULL OR metadata->>'project_key' = $3)
    ORDER  BY embedding <=> $1::vector
    LIMIT  $2
  `, [JSON.stringify(embedding), topK, projectKey])

  // Warn if any high-similarity result was skipped due to being outdated
  const outdatedCheck = await db.query(`
    SELECT
      metadata->>'title' AS title,
      outdated_reason,
      1 - (embedding <=> $1::vector) AS similarity
    FROM   kb_documents
    WHERE  outdated = true
      AND  ($3::text IS NULL OR metadata->>'project_key' = $3)
      AND  1 - (embedding <=> $1::vector) > 0.85
    ORDER  BY similarity DESC
    LIMIT  3
  `, [JSON.stringify(embedding), topK, projectKey])

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

  const projectKey = jiraIssueKey ? jiraIssueKey.split('-')[0] : (approvedTest.jiraKey ? approvedTest.jiraKey.split('-')[0] : null)

  const metadata = {
    title:          approvedTest.title,
    feature_area:   approvedTest.feature || approvedTest.featureArea || null,
    component:      approvedTest.component || null,
    sprint:         approvedTest.sprint || null,
    zephyr_key:     approvedTest.zephyrKey || null,
    jira_issue_key: approvedTest.jiraKey || jiraIssueKey || null,
    project_key:    projectKey,
    approved_by:    approvedTest.approvedBy || 'system',
    doc_type:       'test_case',
    test_type:      approvedTest.testType || 'functional',
    steps,
    tags:           approvedTest.tags || [],
  }

  const id = `test:${randomUUID()}`

  await db.query(`
    INSERT INTO kb_documents (id, source, content, embedding, metadata)
    VALUES ($1, 'generated', $2, $3::vector, $4::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [id, textToEmbed.slice(0, 8000), JSON.stringify(embedding), JSON.stringify(metadata)])

  const newEntry = { ...approvedTest, id, embedding, metadata }
  console.log(`  ✓ Written to KB: "${approvedTest.title}" (id: ${id})`)

  await detectAndHandleDuplicates(newEntry, jiraIssueKey)

  return newEntry
}
