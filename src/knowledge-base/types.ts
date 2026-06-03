/**
 * src/knowledge-base/types.ts
 *
 * Shared types for Knowledge Base documents.
 * Used by LocalKnowledgeBase (Phase 1) and PgKnowledgeBase (Phase 2).
 */

export type KBDocumentSource = 'generated' | 'jira' | 'confluence' | 'zephyr';

export interface KBDocumentMetadata {
  source: KBDocumentSource;
  jira_issue_key: string;
  jira_epic: string;
  feature_area: string;
  component: string;
  approved_by: string;
  project_key: string;
  ingested_at: string; // ISO 8601
  doc_type: 'test_case' | 'acceptance_criteria' | 'architecture';
}

export interface KBDocument {
  /** Unique identifier for deduplication e.g. "generated:PROJ-123:2026-01-01T..." */
  id: string;
  source: KBDocumentSource;
  content: string;
  metadata: KBDocumentMetadata;
}
