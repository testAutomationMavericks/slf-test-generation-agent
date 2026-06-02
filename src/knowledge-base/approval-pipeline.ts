/**
 * src/knowledge-base/approval-pipeline.ts
 *
 * The approval pipeline sits between the agent output and the KB.
 * When a tester approves generated test cases, this:
 *  1. Formats them as a KB document
 *  2. Uploads to S3
 *  3. Triggers Bedrock ingestion
 *  4. Optionally writes to Zephyr Scale
 *
 * Can be triggered interactively (REPL prompt) or programmatically
 * (e.g. from a webhook when a Zephyr test case is marked "approved").
 */

import * as readline from 'readline';
import { writeToKnowledgeBase, formatTestCaseDocument } from './bedrock-kb.js';
import { logger } from '../logger.js';
import { KBWriteBackConfig, ApprovedTestCasePayload } from './types.js';

// ─── Core Approval Function ───────────────────────────────────────────────────

/**
 * Approve and ingest a set of generated test cases into the Knowledge Base.
 *
 * @param payload    - The test case content and metadata
 * @param kbConfig   - Bedrock KB configuration
 * @param waitForSync - Poll Bedrock until ingestion completes
 */
export async function approveAndIngest(
  payload: ApprovedTestCasePayload,
  kbConfig: KBWriteBackConfig,
  waitForSync = false
): Promise<{ jobId: string; s3Keys: string[] }> {
  logger.info(`Approving test cases for ${payload.jiraIssueKey}...`);

  const doc = formatTestCaseDocument(payload.markdownContent, {
    jiraIssueKey: payload.jiraIssueKey,
    jiraEpic: payload.jiraEpic,
    featureArea: payload.featureArea,
    component: payload.component,
    approvedBy: payload.approvedBy,
    projectKey: payload.projectKey,
  });

  const { uploadedKeys, jobId, result } = await writeToKnowledgeBase(
    [doc],
    kbConfig,
    waitForSync
  );

  if (result) {
    logger.info(
      `Ingestion complete — ${result.documentsIndexed} indexed, ` +
        `${result.documentsFailed} failed`
    );

    if (result.documentsFailed > 0) {
      logger.warn(`Failure reasons: ${result.failureReasons.join('; ')}`);
    }
  }

  logger.info(`✓ Test cases for ${payload.jiraIssueKey} written to Knowledge Base`);
  return { jobId, s3Keys: uploadedKeys };
}

// ─── Bulk Source Ingestion ────────────────────────────────────────────────────

import {
  formatJiraDocument,
  formatConfluenceDocument,
  formatZephyrDocument,
  uploadDocumentsBatch,
  startIngestionJob,
  waitForIngestionJob,
} from './bedrock-kb.js';
import { KBDocument } from './types.js';

export interface BulkIngestionOptions {
  jiraIssues?: Array<{
    key: string;
    title: string;
    acceptanceCriteria: string;
    projectKey: string;
    epic?: string;
    component?: string;
  }>;
  confluencePages?: Array<{
    pageId: string;
    title: string;
    content: string;
    spaceKey: string;
    pageType?: string;
  }>;
  zephyrTestCases?: Array<{
    key: string;
    name: string;
    content: string;
    projectKey: string;
    linkedIssue?: string;
    folder?: string;
  }>;
}

/**
 * Bulk-ingest documents from all three sources in a single S3 upload + KB sync.
 * Ideal for initial population of the KB from existing Jira/Confluence/Zephyr data.
 */
export async function bulkIngestSources(
  options: BulkIngestionOptions,
  kbConfig: KBWriteBackConfig,
  waitForSync = true
): Promise<{ totalDocuments: number; jobId: string }> {
  const docs: KBDocument[] = [];

  // Format Jira documents
  for (const issue of options.jiraIssues ?? []) {
    docs.push(
      formatJiraDocument(
        issue.key,
        issue.title,
        issue.acceptanceCriteria,
        { projectKey: issue.projectKey, epic: issue.epic, component: issue.component }
      )
    );
  }

  // Format Confluence documents
  for (const page of options.confluencePages ?? []) {
    docs.push(
      formatConfluenceDocument(page.pageId, page.title, page.content, {
        spaceKey: page.spaceKey,
        pageType: page.pageType,
      })
    );
  }

  // Format Zephyr documents
  for (const tc of options.zephyrTestCases ?? []) {
    docs.push(
      formatZephyrDocument(tc.key, tc.name, tc.content, {
        projectKey: tc.projectKey,
        linkedIssue: tc.linkedIssue,
        folder: tc.folder,
      })
    );
  }

  logger.info(
    `Bulk ingestion: ${docs.length} documents ` +
      `(${options.jiraIssues?.length ?? 0} Jira, ` +
      `${options.confluencePages?.length ?? 0} Confluence, ` +
      `${options.zephyrTestCases?.length ?? 0} Zephyr)`
  );

  await uploadDocumentsBatch(docs, kbConfig);
  const jobId = await startIngestionJob(kbConfig);

  if (waitForSync) {
    await waitForIngestionJob(jobId, kbConfig);
  }

  return { totalDocuments: docs.length, jobId };
}

// ─── Interactive Approval Prompt ──────────────────────────────────────────────

/**
 * Show an interactive approval prompt after the agent generates test cases.
 * If the user approves, triggers KB write-back (and optionally Zephyr write).
 *
 * @param generatedMarkdown - The agent's raw markdown output
 * @param issueKey          - The Jira issue key
 * @param kbConfig          - Bedrock KB configuration
 * @param approver          - Username of the approver
 */
export async function promptForApproval(
  generatedMarkdown: string,
  issueKey: string,
  kbConfig: KBWriteBackConfig,
  approver: string
): Promise<'approved' | 'rejected' | 'skipped'> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('\n' + '─'.repeat(60));
    console.log('APPROVAL REQUIRED');
    console.log('─'.repeat(60));
    console.log(
      `Save these test cases to the Knowledge Base for future reuse?\n`
    );
    console.log('  [y] Yes — approve and save to KB');
    console.log('  [n] No — discard, do not save');
    console.log('  [s] Skip — use without saving\n');

    rl.question('Your choice (y/n/s): ', async (answer) => {
      rl.close();

      const choice = answer.trim().toLowerCase();

      if (choice === 'y' || choice === 'yes') {
        try {
          await approveAndIngest(
            {
              markdownContent: generatedMarkdown,
              jiraIssueKey: issueKey,
              approvedBy: approver,
              projectKey: issueKey.split('-')[0],
            },
            kbConfig,
            true // wait for sync
          );
          console.log(
            `\n✓ Test cases saved to Knowledge Base. Future queries will benefit from this context.\n`
          );
          resolve('approved');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`KB write-back failed: ${msg}`);
          console.error(`\n✗ Failed to save to KB: ${msg}\n`);
          resolve('rejected');
        }
      } else if (choice === 's' || choice === 'skip') {
        console.log('\nSkipped — not saved to KB.\n');
        resolve('skipped');
      } else {
        console.log('\nRejected — not saved to KB.\n');
        resolve('rejected');
      }
    });
  });
}
