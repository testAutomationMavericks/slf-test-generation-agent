/**
 * src/kb/pg-vector-db.ts
 *
 * Phase 2 Knowledge Base — PostgreSQL + pgvector + voyage-3 embeddings.
 *
 * Requires:
 *   - npm install postgres
 *   - ANTHROPIC_API_KEY env var (for voyage-3 embeddings)
 *   - DATABASE_URL env var (postgres connection string)
 *   - pgvector extension + kb_documents table (see src/kb/schema.sql)
 *
 * Drop-in replacement for LocalKnowledgeBase — same interface.
 */

import { KBDocument } from '../knowledge-base/types.js'
import { IKnowledgeBase, RetrieveResult, RetrieveOptions, KBStats } from './interface.js'
import { logger } from '../logger.js'

// ─── Voyage-3 embeddings via Anthropic SDK ────────────────────────────────────

async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch('https://api.anthropic.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: text.slice(0, 8000),
      input_type: 'document',
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Voyage-3 embedding failed: ${err}`)
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
}

async function getQueryEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch('https://api.anthropic.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: text.slice(0, 4000),
      input_type: 'query',
    }),
  })

  if (!res.ok) throw new Error(`Voyage-3 query embedding failed`)
  const data = await res.json() as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
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
    await this.runDuplicateCheck(doc.id, embedding)
  }

  // Runs after every EC2 write. Flags near-duplicates; auto-deletes near-identical ones.
  // Non-fatal — a dedup failure never blocks the write.
  private async runDuplicateCheck(docId: string, embedding: number[]): Promise<void> {
    const autoDelete = parseFloat(process.env.KB_AUTO_DELETE_THRESHOLD || '0.97')
    const flag       = parseFloat(process.env.KB_FLAG_THRESHOLD        || '0.90')

    try {
      const candidates = await this.sql`
        SELECT * FROM find_duplicates(
          ${JSON.stringify(embedding)}::vector,
          ${docId}::text,
          ${flag}
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
    const { topK = 8, minScore = 0.3, filter } = options
    const queryVec = await getQueryEmbedding(query, this.apiKey)

    // Build dynamic WHERE clauses
    let rows: any[]
    if (filter?.source && filter?.jira_issue_key) {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE source = ${filter.source}
          AND metadata->>'jira_issue_key' = ${filter.jira_issue_key}
          AND (outdated IS NULL OR outdated = false)
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else if (filter?.source) {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE source = ${filter.source}
          AND (outdated IS NULL OR outdated = false)
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else if (filter?.jira_issue_key) {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE metadata->>'jira_issue_key' = ${filter.jira_issue_key}
          AND (outdated IS NULL OR outdated = false)
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE (outdated IS NULL OR outdated = false)
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    }

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

    const entries = await this.sql<Array<{ id: string }>>`
      SELECT id FROM kb_documents
      WHERE (outdated IS NULL OR outdated = false) AND embedding IS NOT NULL
    `

    let flagged = 0

    for (const entry of entries) {
      const dupes = await this.sql`
        SELECT id, COALESCE(metadata->>'title', id) AS title
        FROM find_duplicates(
          (SELECT embedding FROM kb_documents WHERE id = ${entry.id}),
          ${entry.id}::text,
          ${threshold}
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
