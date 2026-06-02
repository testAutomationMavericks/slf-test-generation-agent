/**
 * src/knowledge-base/kb-cli.ts
 *
 * CLI tool for managing the Bedrock Knowledge Base:
 *
 *   npx tsx src/knowledge-base/kb-cli.ts status
 *   npx tsx src/knowledge-base/kb-cli.ts seed --project PROJ
 *   npx tsx src/knowledge-base/kb-cli.ts sync
 *   npx tsx src/knowledge-base/kb-cli.ts ingest --file ./my-test-cases.md --issue PROJ-123
 */

import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../logger.js';
import {
  loadKBConfig,
  listRecentIngestionJobs,
  startIngestionJob,
  waitForIngestionJob,
  bulkIngestSources,
  approveAndIngest,
  uploadDocumentToS3,
  formatJiraDocument,
  formatConfluenceDocument,
  formatZephyrDocument,
} from './index.js';
import * as fs from 'fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(): { command: string; options: Record<string, string> } {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'status';
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      options[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  return { command, options };
}

async function createAtlassianClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: {
      ...process.env,
      JIRA_URL: process.env.JIRA_URL!,
      JIRA_USERNAME: process.env.JIRA_USERNAME!,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN!,
      CONFLUENCE_URL: process.env.CONFLUENCE_URL!,
      CONFLUENCE_USERNAME: process.env.CONFLUENCE_USERNAME!,
      CONFLUENCE_API_TOKEN: process.env.CONFLUENCE_API_TOKEN!,
    },
  });
  const client = new Client({ name: 'kb-cli', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function createZephyrClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@smartbear/mcp@latest'],
    env: {
      ...process.env,
      ZEPHYR_API_TOKEN: process.env.ZEPHYR_API_TOKEN!,
      ZEPHYR_BASE_URL: process.env.ZEPHYR_BASE_URL!,
    },
  });
  const client = new Client({ name: 'kb-cli-zephyr', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Show recent ingestion jobs and KB status */
async function cmdStatus(): Promise<void> {
  const config = loadKBConfig();
  console.log('\nKnowledge Base Status');
  console.log('─'.repeat(50));
  console.log(`KB ID:       ${config.knowledgeBaseId}`);
  console.log(`Data Source: ${config.dataSourceId}`);
  console.log(`S3 Bucket:   s3://${config.s3Bucket}/${config.s3Prefix ?? ''}`);
  console.log(`Region:      ${config.awsRegion}\n`);

  const jobs = await listRecentIngestionJobs(config, 5);
  if (jobs.length === 0) {
    console.log('No ingestion jobs found. Run "seed" or "sync" to populate the KB.');
    return;
  }

  console.log('Recent Ingestion Jobs:');
  for (const job of jobs) {
    const date = job.startedAt ? new Date(job.startedAt).toLocaleString() : 'unknown';
    console.log(`  ${job.jobId}  ${job.status.padEnd(12)} ${date}`);
  }
}

/** Trigger a manual KB sync (re-index everything in S3) */
async function cmdSync(): Promise<void> {
  const config = loadKBConfig();
  console.log('\nTriggering Bedrock KB sync...');
  const jobId = await startIngestionJob(config);
  console.log(`Ingestion job started: ${jobId}`);
  console.log('Waiting for completion...');
  const result = await waitForIngestionJob(jobId, config);
  console.log(`\n✓ Sync complete`);
  console.log(`  Indexed:  ${result.documentsIndexed}`);
  console.log(`  Failed:   ${result.documentsFailed}`);
  console.log(`  Deleted:  ${result.documentsDeleted}`);
  if (result.failureReasons.length > 0) {
    console.log(`  Failures: ${result.failureReasons.join('; ')}`);
  }
}

/** Seed the KB from a Jira project — fetches all issues + Confluence + Zephyr */
async function cmdSeed(projectKey: string): Promise<void> {
  const config = loadKBConfig();
  const atlassian = await createAtlassianClient();
  const zephyr = await createZephyrClient();

  console.log(`\nSeeding KB from project ${projectKey}...`);

  // Fetch Jira issues
  console.log('Fetching Jira issues...');
  const jiraResult = await atlassian.callTool({
    name: 'jira_search',
    arguments: { jql: `project = ${projectKey} ORDER BY created DESC`, max_results: 100 },
  });

  const jiraIssues: BulkIngestionOptions['jiraIssues'] = [];
  // Parse the MCP result (structure depends on mcp-atlassian implementation)
  const issues = JSON.parse(JSON.stringify(jiraResult.content)) as Array<{
    key: string; summary: string; description?: string; fields?: { components?: Array<{name: string}> }
  }>;

  for (const issue of issues) {
    jiraIssues.push({
      key: issue.key,
      title: issue.summary,
      acceptanceCriteria: issue.description ?? '',
      projectKey,
      component: issue.fields?.components?.[0]?.name,
    });
  }
  console.log(`  Found ${jiraIssues.length} Jira issues`);

  // Fetch Zephyr test cases
  console.log('Fetching Zephyr test cases...');
  const zephyrResult = await zephyr.callTool({
    name: 'zephyr_get_test_cases',
    arguments: { projectKey, maxResults: 200 },
  });

  const zephyrTestCases: BulkIngestionOptions['zephyrTestCases'] = [];
  const testCases = JSON.parse(JSON.stringify(zephyrResult.content)) as Array<{
    key: string; name: string; objective?: string; precondition?: string; folder?: { name: string }
  }>;

  for (const tc of testCases) {
    const content = [
      tc.objective && `**Objective:** ${tc.objective}`,
      tc.precondition && `**Precondition:** ${tc.precondition}`,
    ].filter(Boolean).join('\n\n');

    zephyrTestCases.push({
      key: tc.key,
      name: tc.name,
      content: content || tc.name,
      projectKey,
      folder: tc.folder?.name,
    });
  }
  console.log(`  Found ${zephyrTestCases.length} Zephyr test cases`);

  await atlassian.close();
  await zephyr.close();

  const { totalDocuments, jobId } = await bulkIngestSources(
    { jiraIssues, zephyrTestCases },
    config,
    true
  );

  console.log(`\n✓ Seeded KB with ${totalDocuments} documents`);
  console.log(`  Ingestion job: ${jobId}`);
}

/** Manually ingest a markdown file as a test case document */
async function cmdIngest(filePath: string, issueKey: string): Promise<void> {
  const config = loadKBConfig();

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  console.log(`\nIngesting ${filePath} for ${issueKey}...`);

  await approveAndIngest(
    {
      markdownContent: content,
      jiraIssueKey: issueKey,
      approvedBy: process.env.USER ?? 'cli',
      projectKey: issueKey.split('-')[0],
    },
    config,
    true
  );

  console.log(`\n✓ Ingested ${filePath} into Knowledge Base`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

import { BulkIngestionOptions } from './approval-pipeline.js';

async function main(): Promise<void> {
  const { command, options } = parseArgs();

  try {
    switch (command) {
      case 'status':
        await cmdStatus();
        break;

      case 'sync':
        await cmdSync();
        break;

      case 'seed': {
        const project = options.project ?? process.env.DEFAULT_JIRA_PROJECT;
        if (!project) {
          console.error('Provide --project PROJ or set DEFAULT_JIRA_PROJECT in .env');
          process.exit(1);
        }
        await cmdSeed(project);
        break;
      }

      case 'ingest': {
        const file = options.file;
        const issue = options.issue;
        if (!file || !issue) {
          console.error('Usage: kb-cli ingest --file ./test-cases.md --issue PROJ-123');
          process.exit(1);
        }
        await cmdIngest(file, issue);
        break;
      }

      default:
        console.log(`Unknown command: ${command}`);
        console.log('Available commands: status | sync | seed | ingest');
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(msg);
    process.exit(1);
  }
}

main();
