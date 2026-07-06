/**
 * src/kb/pg-vector-db.ts
 *
 * Knowledge Base — PostgreSQL + pgvector.
 * Embeddings: Voyage-3 (Anthropic API) when an API key is configured,
 * otherwise a deterministic 1024-dim keyword embedding — same vector
 * dimension so no schema change is needed when switching modes.
 *
 * Requires:
 *   - npm install postgres
 *   - DATABASE_URL env var (postgres connection string)
 *   - pgvector extension + kb_documents table (see src/kb/schema.sql)
 *   - ANTHROPIC_API_KEY (optional — improves retrieval quality via Voyage-3)
 */

import { KBDocument } from '../knowledge-base/types.js'
import { IKnowledgeBase, RetrieveResult, RetrieveOptions, KBStats } from './interface.js'
import { logger } from '../logger.js'

// ─── Deterministic 1024-dim embedding (no API key required) ──────────────────
// Uses character n-grams + word hashing + domain keyword boosts.
// Same quality as the old LocalKnowledgeBase approach, output padded to 1024 dims
// so vectors are compatible with the pgvector(1024) schema.

function localEmbed(text: string): number[] {
  const DIM = 1024
  const vec = new Array<number>(DIM).fill(0)
  const lower = text.toLowerCase()

  // Character bigram hashing
  for (let i = 0; i < lower.length - 1; i++) {
    const h = lower.charCodeAt(i) * 31 + lower.charCodeAt(i + 1) * 17
    vec[((h % DIM) + DIM) % DIM] += 0.5
  }

  // Word hashing
  const words = lower.match(/\b\w+\b/g) ?? []
  for (const word of words) {
    let h = 5381
    for (let i = 0; i < word.length; i++) h = (h * 33) ^ word.charCodeAt(i)
    vec[((h % DIM) + DIM) % DIM] += 1
  }

  // Domain keyword boosts — cluster related test case content together
  const boosts: Record<string, number[]> = {
    login:          [0, 1, 2, 3],       authentication: [0, 1, 2, 4],
    password:       [1, 2, 4, 5],       session:        [2, 3, 5, 6],
    token:          [3, 4, 5, 7],       logout:         [0, 2, 6, 7],
    basket:         [20, 21, 22, 23],   checkout:       [20, 21, 23, 24],
    discount:       [21, 23, 24, 25],   quantity:       [22, 23, 25, 26],
    'test case':    [50, 51, 52, 53],   acceptance:     [50, 51, 53, 54],
    precondition:   [52, 53, 54, 56],   scenario:       [50, 52, 54, 57],
    endpoint:       [80, 82, 83, 84],   api:            [81, 82, 84, 85],
    security:       [84, 85, 86, 87],   regression:     [90, 91, 92, 93],
    'edge case':    [94, 95, 96, 97],   negative:       [95, 96, 97, 98],
  }
  for (const [phrase, dims] of Object.entries(boosts)) {
    if (lower.includes(phrase)) dims.forEach(d => { vec[d] += 8 })
  }

  // L2 normalise
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / mag)
}

// ─── Voyage-3 embeddings (Anthropic API — better quality when key is set) ─────

async function voyage3Embed(text: string, apiKey: string, inputType: 'document' | 'query'): Promise<number[]> {
  const res = await fetch('https://api.anthropic.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: text.slice(0, inputType === 'document' ? 8000 : 4000),
      input_type: inputType,
    }),
  })
  if (!res.ok) throw new Error(`Voyage-3 embedding failed: ${await res.text()}`)
  const data = await res.json() as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
}

async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  if (!apiKey) return localEmbed(text)
  try { return await voyage3Embed(text, apiKey, 'document') }
  catch (e) { logger.warn('Voyage-3 failed, falling back to local embed:', e); return localEmbed(text) }
}

async function getQueryEmbedding(text: string, apiKey: string): Promise<number[]> {
  if (!apiKey) return localEmbed(text)
  try { return await voyage3Embed(text, apiKey, 'query') }
  catch (e) { logger.warn('Voyage-3 failed, falling back to local embed:', e); return localEmbed(text) }
}

// ─── PgKnowledgeBase ──────────────────────────────────────────────────────────

export class PgKnowledgeBase implements IKnowledgeBase {
  private sql: any
  private apiKey: string
  private connected = false

  constructor(connectionUrl: string, anthropicApiKey: string) {
    this.apiKey = anthropicApiKey
    this.initSql(connectionUrl)
  }

  private async initSql(connectionUrl: string) {
    try {
      const { default: postgres } = await import('postgres')
      this.sql = postgres(connectionUrl, {
        ssl: process.env.DB_SSL === 'require' ? 'require' : false,
        max: 10,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => {},
      })
      // Verify the connection is actually reachable before marking ready
      await this.sql`SELECT 1`
      this.connected = true
      logger.info('PgKnowledgeBase: connected to PostgreSQL')
    } catch (e) {
      logger.warn('PgKnowledgeBase: failed to connect — server will use local KB fallback until EC2 is ready —', e)
      this.sql = null
      this.connected = false
    }
  }

  // ── addDocument ─────────────────────────────────────────────────────────────

  async addDocument(doc: KBDocument): Promise<void> {
    if (!this.connected) { logger.warn('PgKB: not connected, skipping addDocument'); return; }
    const embedding = await getEmbedding(doc.content, this.apiKey)
    const meta = { source: doc.source, ...doc.metadata }

    await this.sql`
      INSERT INTO kb_documents (id, source, content, embedding, metadata)
      VALUES (
        ${doc.id},
        ${doc.source},
        ${doc.content.slice(0, 8000)},
        ${JSON.stringify(embedding)}::vector,
        ${JSON.stringify(meta)}::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        source     = EXCLUDED.source,
        content    = EXCLUDED.content,
        embedding  = EXCLUDED.embedding,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW()
    `
    logger.info(`PgKB: upserted "${doc.id}" (${doc.source})`)
    await this.runDuplicateCheck(doc.id, embedding, doc.metadata?.project_key || undefined)
  }

  // Runs after every EC2 write. Flags near-duplicates; auto-deletes near-identical ones.
  // Non-fatal — a dedup failure never blocks the write.
  // projectKey scopes the check to the same project; pass undefined for global.
  private async runDuplicateCheck(docId: string, embedding: number[], projectKey?: string): Promise<void> {
    const autoDelete = parseFloat(process.env.KB_AUTO_DELETE_THRESHOLD || '0.97')
    const flag       = parseFloat(process.env.KB_FLAG_THRESHOLD        || '0.90')

    try {
      const candidates = await this.sql`
        SELECT * FROM find_duplicates(
          ${JSON.stringify(embedding)}::vector,
          ${docId}::text,
          ${flag},
          ${projectKey ?? null}
        )
      ` as Array<{ id: string; title: string; similarity: string }>

      for (const c of candidates) {
        const sim = Number(c.similarity)

        if (sim >= autoDelete) {
          await this.sql`DELETE FROM kb_documents WHERE id = ${c.id}`
          await this.sql`
            INSERT INTO duplicate_log (new_entry_id, old_entry_id, old_entry_title, similarity, action_taken)
            VALUES (${docId}, ${c.id}, ${c.title}, ${sim}, 'auto_deleted')
          `
          logger.warn(`PgKB dedup: auto-deleted "${c.title}" (${(sim * 100).toFixed(1)}% match)`)
        } else {
          await this.sql`
            UPDATE kb_documents
            SET outdated        = true,
                outdated_reason = ${'Possible duplicate of a more recently added entry'},
                outdated_at     = NOW(),
                duplicate_of    = ${docId}
            WHERE id = ${c.id}
              AND (outdated IS NULL OR outdated = false)
          `
          await this.sql`
            INSERT INTO duplicate_log (new_entry_id, old_entry_id, old_entry_title, similarity, action_taken)
            VALUES (${docId}, ${c.id}, ${c.title}, ${sim}, 'flagged')
          `
          logger.warn(`PgKB dedup: flagged "${c.title}" (${(sim * 100).toFixed(1)}% match)`)
        }
      }

      if (candidates.length > 0) {
        logger.info(`PgKB dedup: processed ${candidates.length} candidate(s) for "${docId}"`)
      }
    } catch (e) {
      logger.warn('PgKB: duplicate check failed (non-fatal):', e)
    }
  }

  // ── addDocuments ────────────────────────────────────────────────────────────

  async addDocuments(docs: KBDocument[]): Promise<void> {
    for (const doc of docs) await this.addDocument(doc)
  }

  // ── retrieve ────────────────────────────────────────────────────────────────

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult[]> {
    if (!this.connected) { logger.warn('PgKB: not connected, returning empty results'); return []; }
    const { topK = 8, minScore = 0.3, filter, projectKeys } = options
    const queryVec = await getQueryEmbedding(query, this.apiKey)
    const vec = JSON.stringify(queryVec)

    // Build WHERE fragments — each is empty sql when the filter isn't set
    const sourceF  = filter?.source         ? this.sql`AND source = ${filter.source}` : this.sql``
    const issueF   = filter?.jira_issue_key ? this.sql`AND metadata->>'jira_issue_key' = ${filter.jira_issue_key}` : this.sql``
    // projectKeys (multi) takes priority over filter.project_key (single)
    const projectF = projectKeys?.length
      ? this.sql`AND metadata->>'project_key' IN ${this.sql(projectKeys)}`
      : filter?.project_key
        ? this.sql`AND metadata->>'project_key' = ${filter.project_key}`
        : this.sql``

    const rows: any[] = await this.sql`
      SELECT id, content, metadata,
             1 - (embedding <=> ${vec}::vector) AS score
      FROM   kb_documents
      WHERE  (outdated IS NULL OR outdated = false)
        ${sourceF}
        ${issueF}
        ${projectF}
      ORDER  BY embedding <=> ${vec}::vector
      LIMIT  ${topK}
    `

    return rows
      .filter(r => Number(r.score) >= minScore)
      .map(r => ({
        content: r.content,
        score: Number(r.score),
        metadata: r.metadata as Record<string, string>,
      }))
  }

  // ── deleteDocument ──────────────────────────────────────────────────────────

  async deleteDocument(id: string): Promise<void> {
    if (!this.connected) { logger.warn('PgKB: not connected, skipping deleteDocument'); return; }
    await this.sql`DELETE FROM kb_documents WHERE id = ${id}`
  }

  // ── clear ───────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    if (!this.connected) { logger.warn('PgKB: not connected, skipping clear'); return; }
    await this.sql`TRUNCATE TABLE kb_documents RESTART IDENTITY`
    logger.info('PgKB: cleared all documents')
  }

  // ── listIds ─────────────────────────────────────────────────────────────────

  async listIds(): Promise<string[]> {
    if (!this.connected) { return []; }
    const rows = await this.sql`SELECT id FROM kb_documents ORDER BY created_at DESC`
    return rows.map((r: any) => r.id as string)
  }

  // ── getStats ─────────────────────────────────────────────────────────────────

  async getStats(): Promise<KBStats> {
    if (!this.connected || !this.sql) {
      return { total: 0, backend: 'pgvector', lastUpdated: undefined }
    }
    try {
      const [{ count }] = await this.sql`SELECT COUNT(*)::int AS count FROM kb_documents`
      const latest = await this.sql`
        SELECT updated_at FROM kb_documents ORDER BY updated_at DESC LIMIT 1
      `
      return {
        total: count as number,
        backend: 'pgvector',
        lastUpdated: latest[0]?.updated_at?.toISOString(),
      }
    } catch {
      return { total: 0, backend: 'pgvector' }
    }
  }

  // ── scanAndFlagDuplicates ────────────────────────────────────────────────────
  // Used by migrate.ts post-migration. Flags near-duplicates; never auto-deletes.

  async scanAndFlagDuplicates(threshold = 0.90): Promise<{ scanned: number; flagged: number }> {
    if (!this.connected || !this.sql) return { scanned: 0, flagged: 0 }

    const entries = await this.sql<Array<{ id: string; project_key: string | null }>>`
      SELECT id, metadata->>'project_key' AS project_key
      FROM kb_documents
      WHERE (outdated IS NULL OR outdated = false) AND embedding IS NOT NULL
    `

    let flagged = 0

    for (const entry of entries) {
      const dupes = await this.sql`
        SELECT id, COALESCE(metadata->>'title', id) AS title
        FROM find_duplicates(
          (SELECT embedding FROM kb_documents WHERE id = ${entry.id}),
          ${entry.id}::text,
          ${threshold},
          ${entry.project_key ?? null}
        )
      `

      for (const dupe of dupes as Array<{ id: string; title: string }>) {
        const updated = await this.sql`
          UPDATE kb_documents
          SET outdated        = true,
              outdated_reason = 'Flagged as possible duplicate during migration scan',
              outdated_at     = NOW(),
              duplicate_of    = ${entry.id}
          WHERE id = ${dupe.id}
            AND (outdated IS NULL OR outdated = false)
          RETURNING id
        `
        if (updated.length > 0) {
          flagged++
          logger.info(`PgKB scan: flagged "${dupe.title}" as duplicate of ${entry.id}`)
        }
      }
    }

    return { scanned: entries.length, flagged }
  }

  // ── disconnect ───────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    if (this.sql) {
      await this.sql.end()
      this.connected = false
    }
  }

  // ── health check ─────────────────────────────────────────────────────────────

  async isHealthy(): Promise<boolean> {
    if (!this.connected || !this.sql) return false
    try {
      await this.sql`SELECT 1`
      return true
    } catch {
      return false
    }
  }
}
