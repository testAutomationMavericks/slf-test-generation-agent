/**
 * src/kb/interface.ts
 *
 * Shared interface for all Knowledge Base backends.
 * LocalKnowledgeBase (Phase 1) and PgKnowledgeBase (Phase 2) both implement this.
 * Server code only ever uses IKnowledgeBase — swap backends with zero other changes.
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
}

export interface KBStats {
  total: number
  dataDir?: string       // local only
  connectionUrl?: string // pg only
  lastUpdated?: string
  backend: 'local' | 'pgvector'
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
