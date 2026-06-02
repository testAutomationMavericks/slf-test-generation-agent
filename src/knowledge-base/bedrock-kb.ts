/**
 * src/knowledge-base/bedrock-kb.ts
 *
 * Writes approved test cases and source documents to S3, then
 * triggers an AWS Bedrock Knowledge Base ingestion sync so Claude
 * can retrieve them in future queries.
 *
 * Flow:
 *   Approved content → format as KB document → upload to S3
 *   → startIngestionJob on Bedrock KB → poll until complete
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
  ListIngestionJobsCommand,
  type StartIngestionJobCommandInput,
} from '@aws-sdk/client-bedrock-agent';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import {
  KBDocument,
  KBDocumentSource,
  IngestionResult,
  KBWriteBackConfig,
} from './types.js';

// ─── Client Initialisation ────────────────────────────────────────────────────

function createS3Client(config: KBWriteBackConfig): S3Client {
  return new S3Client({
    region: config.awsRegion,
    ...(config.awsProfile
      ? { credentials: { accessKeyId: '', secretAccessKey: '' } } // resolved by SDK from profile
      : {}),
  });
}

function createBedrockClient(config: KBWriteBackConfig): BedrockAgentClient {
  return new BedrockAgentClient({ region: config.awsRegion });
}

// ─── Document Formatters ──────────────────────────────────────────────────────

/**
 * Format a generated test case batch as a KB document.
 * Metadata is stored alongside the text so Bedrock can filter by it.
 */
export function formatTestCaseDocument(
  testCasesMarkdown: string,
  meta: {
    jiraIssueKey: string;
    jiraEpic?: string;
    featureArea?: string;
    component?: string;
    approvedBy: string;
    projectKey: string;
  }
): KBDocument {
  return {
    id: `generated:${meta.jiraIssueKey}:${Date.now()}`,
    source: 'generated',
    content: testCasesMarkdown,
    metadata: {
      source: 'generated',
      jira_issue_key: meta.jiraIssueKey,
      jira_epic: meta.jiraEpic ?? '',
      feature_area: meta.featureArea ?? '',
      component: meta.component ?? '',
      approved_by: meta.approvedBy,
      project_key: meta.projectKey,
      ingested_at: new Date().toISOString(),
      doc_type: 'test_cases',
    },
  };
}

/**
 * Format a Jira acceptance criteria fetch as a KB document.
 */
export function formatJiraDocument(
  issueKey: string,
  issueTitle: string,
  acceptanceCriteria: string,
  meta: { projectKey: string; epic?: string; component?: string }
): KBDocument {
  const content = `# ${issueKey}: ${issueTitle}\n\n## Acceptance Criteria\n\n${acceptanceCriteria}`;
  return {
    id: `jira:${issueKey}`,
    source: 'jira',
    content,
    metadata: {
      source: 'jira',
      jira_issue_key: issueKey,
      jira_epic: meta.epic ?? '',
      feature_area: '',
      component: meta.component ?? '',
      approved_by: 'system',
      project_key: meta.projectKey,
      ingested_at: new Date().toISOString(),
      doc_type: 'acceptance_criteria',
    },
  };
}

/**
 * Format a Confluence page as a KB document.
 */
export function formatConfluenceDocument(
  pageId: string,
  pageTitle: string,
  pageContent: string,
  meta: { spaceKey: string; pageType?: string }
): KBDocument {
  const content = `# ${pageTitle}\n\n${pageContent}`;
  return {
    id: `confluence:${pageId}`,
    source: 'confluence',
    content,
    metadata: {
      source: 'confluence',
      jira_issue_key: '',
      jira_epic: '',
      feature_area: '',
      component: '',
      approved_by: 'system',
      project_key: meta.spaceKey,
      ingested_at: new Date().toISOString(),
      doc_type: meta.pageType ?? 'documentation',
    },
  };
}

/**
 * Format a Zephyr test case as a KB document.
 */
export function formatZephyrDocument(
  testCaseKey: string,
  testCaseName: string,
  testCaseContent: string,
  meta: { projectKey: string; linkedIssue?: string; folder?: string }
): KBDocument {
  const content = `# Test Case: ${testCaseKey} — ${testCaseName}\n\n${testCaseContent}`;
  return {
    id: `zephyr:${testCaseKey}`,
    source: 'zephyr',
    content,
    metadata: {
      source: 'zephyr',
      jira_issue_key: meta.linkedIssue ?? '',
      jira_epic: '',
      feature_area: meta.folder ?? '',
      component: '',
      approved_by: 'system',
      project_key: meta.projectKey,
      ingested_at: new Date().toISOString(),
      doc_type: 'test_case',
    },
  };
}

// ─── S3 Upload ────────────────────────────────────────────────────────────────

/**
 * Derive the S3 key from the document source and ID.
 * e.g. generated/PROJ-123/1716800000000.json
 */
function s3KeyFor(doc: KBDocument, prefix?: string): string {
  const base = prefix ? `${prefix}/` : '';
  const sanitised = doc.id.replace(/[^a-zA-Z0-9:_-]/g, '_');
  return `${base}${doc.source}/${sanitised}.json`;
}

/**
 * Upload a single KB document to S3.
 * The file contains both the text content and Bedrock metadata.
 */
export async function uploadDocumentToS3(
  doc: KBDocument,
  config: KBWriteBackConfig
): Promise<{ key: string; bucket: string }> {
  const s3 = createS3Client(config);
  const key = s3KeyFor(doc, config.s3Prefix);

  // Bedrock Knowledge Bases expect a specific JSON structure when
  // using the S3 data source with metadata filtering.
  const payload = {
    // The text Bedrock will embed and index
    content: doc.content,
    // Metadata fields for filtered retrieval
    metadata: doc.metadata,
  };

  const params: PutObjectCommandInput = {
    Bucket: config.s3Bucket,
    Key: key,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json',
    // Metadata also stored as S3 object metadata for easy inspection
    Metadata: Object.fromEntries(
      Object.entries(doc.metadata).map(([k, v]) => [k, String(v)])
    ),
  };

  logger.info(`Uploading to s3://${config.s3Bucket}/${key}`);
  await s3.send(new PutObjectCommand(params));
  logger.info(`✓ Uploaded ${doc.id}`);

  return { key, bucket: config.s3Bucket };
}

/**
 * Upload multiple documents in parallel (with concurrency limit).
 */
export async function uploadDocumentsBatch(
  docs: KBDocument[],
  config: KBWriteBackConfig,
  concurrency = 5
): Promise<Array<{ key: string; bucket: string }>> {
  const results: Array<{ key: string; bucket: string }> = [];

  for (let i = 0; i < docs.length; i += concurrency) {
    const batch = docs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((doc) => uploadDocumentToS3(doc, config))
    );
    results.push(...batchResults);
    logger.info(`Uploaded batch ${Math.floor(i / concurrency) + 1}: ${batch.length} documents`);
  }

  return results;
}

// ─── Bedrock KB Ingestion ─────────────────────────────────────────────────────

/**
 * Start a Bedrock Knowledge Base ingestion job to sync the S3 data source.
 * Bedrock will embed and index all new/changed documents in the bucket.
 */
export async function startIngestionJob(
  config: KBWriteBackConfig
): Promise<string> {
  const bedrock = createBedrockClient(config);

  const params: StartIngestionJobCommandInput = {
    knowledgeBaseId: config.knowledgeBaseId,
    dataSourceId: config.dataSourceId,
    clientToken: randomUUID(), // Idempotency key
    description: `Sync triggered by atlassian-test-agent at ${new Date().toISOString()}`,
  };

  logger.info(
    `Starting ingestion job for KB ${config.knowledgeBaseId} / DS ${config.dataSourceId}...`
  );

  const response = await bedrock.send(new StartIngestionJobCommand(params));
  const jobId = response.ingestionJob?.ingestionJobId;

  if (!jobId) {
    throw new Error('Bedrock did not return an ingestion job ID');
  }

  logger.info(`✓ Ingestion job started: ${jobId}`);
  return jobId;
}

/**
 * Poll an ingestion job until it completes or fails.
 * Returns the final job status.
 */
export async function waitForIngestionJob(
  jobId: string,
  config: KBWriteBackConfig,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<IngestionResult> {
  const bedrock = createBedrockClient(config);
  const pollInterval = options.pollIntervalMs ?? 5000;
  const timeout = options.timeoutMs ?? 300_000; // 5 minutes
  const startTime = Date.now();

  logger.info(`Polling ingestion job ${jobId}...`);

  while (Date.now() - startTime < timeout) {
    const response = await bedrock.send(
      new GetIngestionJobCommand({
        knowledgeBaseId: config.knowledgeBaseId,
        dataSourceId: config.dataSourceId,
        ingestionJobId: jobId,
      })
    );

    const job = response.ingestionJob;
    if (!job) throw new Error('Ingestion job not found');

    const status = job.status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info(`  [${elapsed}s] Job ${jobId}: ${status}`);

    if (status === 'COMPLETE') {
      const stats = job.statistics;
      logger.info(
        `✓ Ingestion complete — indexed: ${stats?.numberOfDocumentsIndexed ?? 0}, ` +
          `failed: ${stats?.numberOfDocumentsFailed ?? 0}, ` +
          `deleted: ${stats?.numberOfDocumentsDeleted ?? 0}`
      );
      return {
        jobId,
        status: 'COMPLETE',
        documentsIndexed: stats?.numberOfDocumentsIndexed ?? 0,
        documentsFailed: stats?.numberOfDocumentsFailed ?? 0,
        documentsDeleted: stats?.numberOfDocumentsDeleted ?? 0,
        failureReasons: job.failureReasons ?? [],
      };
    }

    if (status === 'FAILED') {
      const reasons = job.failureReasons?.join('; ') ?? 'Unknown error';
      throw new Error(`Ingestion job failed: ${reasons}`);
    }

    // STARTING or IN_PROGRESS — keep polling
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Ingestion job ${jobId} timed out after ${timeout / 1000}s`);
}

/**
 * Get the status of recent ingestion jobs for this data source.
 */
export async function listRecentIngestionJobs(
  config: KBWriteBackConfig,
  maxResults = 5
): Promise<Array<{ jobId: string; status: string; startedAt?: Date }>> {
  const bedrock = createBedrockClient(config);

  const response = await bedrock.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId: config.knowledgeBaseId,
      dataSourceId: config.dataSourceId,
      maxResults,
    })
  );

  return (response.ingestionJobSummaries ?? []).map((j) => ({
    jobId: j.ingestionJobId ?? '',
    status: j.status ?? 'UNKNOWN',
    startedAt: j.startedAt,
  }));
}

// ─── High-Level Write-Back ────────────────────────────────────────────────────

/**
 * Full write-back pipeline:
 *  1. Upload documents to S3
 *  2. Start Bedrock ingestion job
 *  3. Optionally wait for completion
 *
 * @param docs      - One or more KB documents to ingest
 * @param config    - AWS + KB configuration
 * @param waitForSync - If true, polls until the ingestion job completes
 */
export async function writeToKnowledgeBase(
  docs: KBDocument[],
  config: KBWriteBackConfig,
  waitForSync = false
): Promise<{ uploadedKeys: string[]; jobId: string; result?: IngestionResult }> {
  if (docs.length === 0) {
    logger.warn('writeToKnowledgeBase called with no documents — skipping');
    return { uploadedKeys: [], jobId: '' };
  }

  logger.info(`Writing ${docs.length} document(s) to Knowledge Base...`);

  // Step 1: Upload all documents to S3
  const uploads = await uploadDocumentsBatch(docs, config);
  const uploadedKeys = uploads.map((u) => u.key);

  logger.info(`✓ ${uploadedKeys.length} documents staged in S3`);

  // Step 2: Trigger Bedrock ingestion
  const jobId = await startIngestionJob(config);

  // Step 3: Optionally wait for sync
  if (waitForSync) {
    const result = await waitForIngestionJob(jobId, config);
    return { uploadedKeys, jobId, result };
  }

  logger.info(`Ingestion job ${jobId} started. Run listRecentIngestionJobs() to check status.`);
  return { uploadedKeys, jobId };
}

// ─── Convenience: Check if document already exists ───────────────────────────

export async function documentExistsInS3(
  doc: KBDocument,
  config: KBWriteBackConfig
): Promise<boolean> {
  const s3 = createS3Client(config);
  const key = s3KeyFor(doc, config.s3Prefix);

  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
