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
      // Dynamically import postgres to avoid breaking mock mode if not installed
      const { default: postgres } = await import('postgres')
      this.sql = postgres(connectionUrl, {
        ssl: 'require',
        max: 10,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => {},
      })
      this.connected = true
      logger.info('PgKnowledgeBase: connected to PostgreSQL')
    } catch (e) {
      logger.warn('PgKnowledgeBase: failed to connect —', e)
      this.connected = false
    }
  }

  private ensureConnected() {
    if (!this.connected || !this.sql) {
      throw new Error('PgKnowledgeBase not connected. Check DATABASE_URL and run: npm install postgres')
    }
  }

  // ── addDocument ─────────────────────────────────────────────────────────────

  async addDocument(doc: KBDocument): Promise<void> {
    this.ensureConnected()
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
  }

  // ── addDocuments ────────────────────────────────────────────────────────────

  async addDocuments(docs: KBDocument[]): Promise<void> {
    for (const doc of docs) await this.addDocument(doc)
  }

  // ── retrieve ────────────────────────────────────────────────────────────────

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult[]> {
    this.ensureConnected()
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
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else if (filter?.source) {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE source = ${filter.source}
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else if (filter?.jira_issue_key) {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
        WHERE metadata->>'jira_issue_key' = ${filter.jira_issue_key}
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${topK}
      `
    } else {
      rows = await this.sql`
        SELECT id, content, metadata,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS score
        FROM kb_documents
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
    this.ensureConnected()
    await this.sql`DELETE FROM kb_documents WHERE id = ${id}`
  }

  // ── clear ───────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    this.ensureConnected()
    await this.sql`TRUNCATE TABLE kb_documents RESTART IDENTITY`
    logger.info('PgKB: cleared all documents')
  }

  // ── listIds ─────────────────────────────────────────────────────────────────

  async listIds(): Promise<string[]> {
    this.ensureConnected()
    const rows = await this.sql`
      SELECT id FROM kb_documents ORDER BY created_at DESC
    `
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
