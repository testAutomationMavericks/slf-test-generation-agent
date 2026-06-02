/**
 * src/knowledge-base/bedrock-retrieval.ts
 *
 * Retrieves relevant context from the Bedrock Knowledge Base
 * to augment Claude's prompt before generating test cases.
 *
 * This is the "read" side of the KB loop — the write side is bedrock-kb.ts.
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type RetrieveCommandInput,
  type RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { logger } from '../logger.js';
import { KBWriteBackConfig } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetrievalOptions {
  /** Number of results to retrieve (default: 10) */
  numberOfResults?: number;
  /** Filter by metadata fields */
  filter?: KBRetrievalFilter;
  /** Minimum relevance score (0-1, default: 0.4) */
  minimumScore?: number;
}

export interface KBRetrievalFilter {
  /** Only return documents from these sources */
  sources?: Array<'generated' | 'jira' | 'confluence' | 'zephyr'>;
  /** Only return documents for this project key */
  projectKey?: string;
  /** Only return documents for this Jira issue */
  jiraIssueKey?: string;
  /** Only return documents for this feature area */
  featureArea?: string;
  /** Only return documents of these types */
  docTypes?: Array<'test_cases' | 'acceptance_criteria' | 'documentation' | 'test_case'>;
}

export interface KBRetrievalResult {
  text: string;
  score: number;
  metadata: Record<string, string>;
  location?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

function createRuntimeClient(config: Pick<KBWriteBackConfig, 'awsRegion'>): BedrockAgentRuntimeClient {
  return new BedrockAgentRuntimeClient({ region: config.awsRegion });
}

// ─── Filter Builder ───────────────────────────────────────────────────────────

function buildFilter(filter?: KBRetrievalFilter): RetrievalFilter | undefined {
  if (!filter) return undefined;

  const conditions: RetrievalFilter[] = [];

  if (filter.sources && filter.sources.length > 0) {
    if (filter.sources.length === 1) {
      conditions.push({
        equals: { key: 'source', value: filter.sources[0] },
      });
    } else {
      conditions.push({
        in: { key: 'source', value: filter.sources },
      });
    }
  }

  if (filter.projectKey) {
    conditions.push({
      equals: { key: 'project_key', value: filter.projectKey },
    });
  }

  if (filter.jiraIssueKey) {
    conditions.push({
      equals: { key: 'jira_issue_key', value: filter.jiraIssueKey },
    });
  }

  if (filter.featureArea) {
    conditions.push({
      equals: { key: 'feature_area', value: filter.featureArea },
    });
  }

  if (filter.docTypes && filter.docTypes.length > 0) {
    if (filter.docTypes.length === 1) {
      conditions.push({
        equals: { key: 'doc_type', value: filter.docTypes[0] },
      });
    } else {
      conditions.push({
        in: { key: 'doc_type', value: filter.docTypes },
      });
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { andAll: conditions };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Retrieve relevant documents from the Bedrock Knowledge Base.
 *
 * @param query   - Natural language query (e.g. "login acceptance criteria")
 * @param config  - KB config (uses knowledgeBaseId)
 * @param options - Number of results, filters, score threshold
 */
export async function retrieveFromKB(
  query: string,
  config: KBWriteBackConfig,
  options: RetrievalOptions = {}
): Promise<KBRetrievalResult[]> {
  const client = createRuntimeClient(config);
  const numberOfResults = options.numberOfResults ?? 10;
  const minimumScore = options.minimumScore ?? 0.4;

  const params: RetrieveCommandInput = {
    knowledgeBaseId: config.knowledgeBaseId,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults,
        ...(options.filter
          ? { filter: buildFilter(options.filter) }
          : {}),
      },
    },
  };

  logger.debug(`KB retrieval: "${query.slice(0, 80)}..." (top ${numberOfResults})`);

  const response = await client.send(new RetrieveCommand(params));
  const results = response.retrievalResults ?? [];

  // Filter by minimum score and map to our type
  return results
    .filter((r) => (r.score ?? 0) >= minimumScore)
    .map((r) => ({
      text: r.content?.text ?? '',
      score: r.score ?? 0,
      metadata: Object.fromEntries(
        Object.entries(r.metadata ?? {}).map(([k, v]) => [k, String(v)])
      ),
      location: r.location?.s3Location?.uri,
    }));
}

// ─── Context Builder ──────────────────────────────────────────────────────────

/**
 * Build a formatted context string from KB results for inclusion in a Claude prompt.
 * Groups results by source type for readability.
 */
export function buildKBContext(results: KBRetrievalResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const grouped: Record<string, KBRetrievalResult[]> = {};
  for (const r of results) {
    const source = r.metadata.source ?? 'unknown';
    if (!grouped[source]) grouped[source] = [];
    grouped[source].push(r);
  }

  const sections: string[] = [
    '## Relevant Knowledge Base Context\n',
    '_The following was retrieved from your team\'s accumulated knowledge base. ' +
      'Use it to inform test case generation and avoid duplication._\n',
  ];

  const sourceLabels: Record<string, string> = {
    generated: 'Previously Generated Test Cases',
    jira: 'Jira Acceptance Criteria',
    confluence: 'Confluence Documentation',
    zephyr: 'Existing Zephyr Test Cases',
  };

  for (const [source, items] of Object.entries(grouped)) {
    sections.push(`### ${sourceLabels[source] ?? source}`);
    for (const item of items) {
      const meta = item.metadata;
      const header = [
        meta.jira_issue_key && `Issue: ${meta.jira_issue_key}`,
        meta.feature_area && `Area: ${meta.feature_area}`,
        `Relevance: ${(item.score * 100).toFixed(0)}%`,
      ]
        .filter(Boolean)
        .join(' · ');

      sections.push(`\n_${header}_\n`);
      sections.push(item.text.slice(0, 1500)); // Truncate very long docs
      sections.push('');
    }
  }

  return sections.join('\n');
}

// ─── Convenience: Retrieve context for a Jira issue ──────────────────────────

/**
 * Retrieve all KB context relevant to a Jira issue:
 * - Existing test cases for this issue
 * - Similar test cases from the same project/area
 * - Related acceptance criteria
 * - Related documentation
 *
 * Returns a formatted string ready to inject into a Claude prompt.
 */
export async function retrieveContextForIssue(
  issueKey: string,
  projectKey: string,
  featureArea: string | undefined,
  config: KBWriteBackConfig
): Promise<string> {
  logger.info(`Retrieving KB context for ${issueKey}...`);

  // Run two queries in parallel:
  // 1. Exact match for this issue
  // 2. Semantic similarity for the project/feature area
  const [exactResults, similarResults] = await Promise.all([
    retrieveFromKB(`test cases for ${issueKey}`, config, {
      numberOfResults: 5,
      filter: { jiraIssueKey: issueKey },
    }).catch(() => []), // Don't fail if KB is empty

    retrieveFromKB(
      `acceptance criteria and test cases for ${featureArea ?? projectKey} features`,
      config,
      {
        numberOfResults: 8,
        filter: {
          projectKey,
          sources: ['generated', 'zephyr', 'jira'],
          ...(featureArea ? { featureArea } : {}),
        },
        minimumScore: 0.5,
      }
    ).catch(() => []),
  ]);

  // Deduplicate by content
  const seen = new Set<string>();
  const allResults: KBRetrievalResult[] = [];

  for (const r of [...exactResults, ...similarResults]) {
    const key = r.text.slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      allResults.push(r);
    }
  }

  logger.info(`Retrieved ${allResults.length} KB documents for ${issueKey}`);
  return buildKBContext(allResults);
}
