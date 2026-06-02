/**
 * src/knowledge-base/types.ts
 *
 * Types for the Bedrock Knowledge Base write-back pipeline.
 */

// ─── Document ─────────────────────────────────────────────────────────────────

export type KBDocumentSource = 'generated' | 'jira' | 'confluence' | 'zephyr';

export interface KBDocumentMetadata {
  source: KBDocumentSource;
  jira_issue_key: string;
  jira_epic: string;
  feature_area: string;
  component: string;
  approved_by: string;
  project_key: string;
  ingested_at: string;  // ISO 8601
  doc_type:
    | 'test_cases'
    | 'acceptance_criteria'
    | 'documentation'
    | 'test_case';
}

export interface KBDocument {
  /** Unique identifier for deduplication. e.g. "generated:PROJ-123:1716800000" */
  id: string;
  source: KBDocumentSource;
  /** The text Bedrock will embed and index */
  content: string;
  metadata: KBDocumentMetadata;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface KBWriteBackConfig {
  /** AWS region where Bedrock and S3 are deployed, e.g. "us-east-1" */
  awsRegion: string;
  /** S3 bucket name that backs the Bedrock data source */
  s3Bucket: string;
  /** Optional key prefix within the bucket, e.g. "kb-docs" */
  s3Prefix?: string;
  /** Bedrock Knowledge Base ID (from AWS console) */
  knowledgeBaseId: string;
  /** Bedrock Data Source ID linked to the S3 bucket */
  dataSourceId: string;
  /** Optional AWS named profile (uses default credential chain if omitted) */
  awsProfile?: string;
}

// ─── Ingestion ────────────────────────────────────────────────────────────────

export interface IngestionResult {
  jobId: string;
  status: 'COMPLETE' | 'FAILED' | 'IN_PROGRESS' | 'STARTING';
  documentsIndexed: number;
  documentsFailed: number;
  documentsDeleted: number;
  failureReasons: string[];
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovedTestCasePayload {
  /** Raw markdown output from the agent */
  markdownContent: string;
  /** Jira issue the tests were generated for */
  jiraIssueKey: string;
  jiraEpic?: string;
  featureArea?: string;
  component?: string;
  /** Person or system that approved the test cases */
  approvedBy: string;
  projectKey: string;
}
