/**
 * src/kb/interface.ts
 *
 * Knowledge Base interface implemented by PgKnowledgeBase.
 * Server code uses IKnowledgeBase throughout.
 */

import { KBDocument } from '../knowledge-base/types.js'

export interface RetrieveResult {
  content: string
  score: number
  metadata: Record<string, string>
}

export interface RetrieveOptions {
  topK?: number
  minScore?: number
  filter?: Partial<Record<string, string>>
  /** Multi-project scope — overrides filter.project_key when provided */
  projectKeys?: string[]
}

export interface KBStats {
  total: number
  connectionUrl?: string
  lastUpdated?: string
  backend: 'pgvector'
}

export interface IKnowledgeBase {
  addDocument(doc: KBDocument): Promise<void>
  addDocuments(docs: KBDocument[]): Promise<void>
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult[]>
  deleteDocument(id: string): Promise<void>
  clear(): Promise<void>
  listIds(): Promise<string[]>
  getStats(): KBStats | Promise<KBStats>
  disconnect?(): Promise<void>
}
