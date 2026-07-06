/**
 * src/local-kb/local-vector-db.ts
 *
 * Local file-based vector database — zero external dependencies.
 * No vectra, no openai, no axios. Pure Node.js + fs.
 *
 * Stores documents as JSON in ./local-kb-data/index.json
 * Uses cosine similarity over deterministic keyword-weighted vectors.
 *
 * Implements the IKnowledgeBase interface — can be swapped for PgKnowledgeBase
 * (Phase 2) by changing the import in ui/server.ts.
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger.js';
import { KBDocument } from '../knowledge-base/types.js';
import type { IKnowledgeBase } from '../kb/interface.js';

// ─── Vector Dimension ─────────────────────────────────────────────────────────

const DIM = 256;

// ─── Embedding ────────────────────────────────────────────────────────────────

/**
 * Deterministic keyword-weighted embedding.
 * Produces consistent vectors for the same text so cosine similarity
 * correctly groups semantically related documents (login/auth,
 * basket/checkout etc.) without any external API calls.
 *
 * Swap this function for a real embedding API call before going to production.
 */
function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const lower = text.toLowerCase();

  // Character n-gram hashing — gives base signal from raw text
  for (let i = 0; i < lower.length - 1; i++) {
    const bigram = lower.charCodeAt(i) * 31 + lower.charCodeAt(i + 1) * 17;
    vec[((bigram % DIM) + DIM) % DIM] += 0.5;
  }

  // Word-level signal
  const words = lower.match(/\b\w+\b/g) ?? [];
  for (const word of words) {
    let h = 5381;
    for (let i = 0; i < word.length; i++) h = (h * 33) ^ word.charCodeAt(i);
    vec[((h % DIM) + DIM) % DIM] += 1;
  }

  // Domain keyword boosts — clusters related docs together in vector space
  const boosts: Record<string, number[]> = {
    // Auth cluster
    login:           [0, 1, 2, 3],
    authentication:  [0, 1, 2, 4],
    password:        [1, 2, 4, 5],
    session:         [2, 3, 5, 6],
    token:           [3, 4, 5, 7],
    logout:          [0, 2, 6, 7],
    lockout:         [1, 3, 6, 8],
    // Basket/checkout cluster
    basket:          [20, 21, 22, 23],
    checkout:        [20, 21, 23, 24],
    discount:        [21, 23, 24, 25],
    'add to basket': [20, 22, 23, 26],
    quantity:        [22, 23, 25, 26],
    stock:           [23, 24, 26, 27],
    // Testing cluster
    'test case':     [50, 51, 52, 53],
    'acceptance':    [50, 51, 53, 54],
    criteria:        [51, 52, 53, 55],
    precondition:    [52, 53, 54, 56],
    scenario:        [50, 52, 54, 57],
    given:           [50, 53, 55, 57],
    when:            [51, 54, 55, 58],
    then:            [52, 55, 56, 58],
    // Architecture cluster
    architecture:    [80, 81, 82, 83],
    endpoint:        [80, 82, 83, 84],
    api:             [81, 82, 84, 85],
    service:         [80, 83, 84, 86],
    database:        [82, 83, 85, 86],
    security:        [84, 85, 86, 87],
  };

  for (const [phrase, dims] of Object.entries(boosts)) {
    if (lower.includes(phrase)) {
      dims.forEach((d) => { vec[d] += 8; });
    }
  }

  // L2 normalise to unit vector
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already unit vectors
}

// ─── Storage ──────────────────────────────────────────────────────────────────

interface StoredEntry {
  id: string;
  vector: number[];
  metadata: Record<string, string>;
  content: string;
}

interface IndexFile {
  version: number;
  entries: StoredEntry[];
  stats: { total: number; lastUpdated: string };
}

// ─── Local Knowledge Base ─────────────────────────────────────────────────────

export class LocalKnowledgeBase {
  private indexPath: string;
  private dataDir: string;
  private cache: IndexFile | null = null;

  constructor(dataDir = './local-kb-data') {
    this.dataDir = path.resolve(process.cwd(), dataDir);
    this.indexPath = path.join(this.dataDir, 'index.json');
  }

  private load(): IndexFile {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.indexPath)) {
      this.cache = { version: 1, entries: [], stats: { total: 0, lastUpdated: new Date().toISOString() } };
      return this.cache;
    }
    this.cache = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as IndexFile;
    return this.cache;
  }

  private save(index: IndexFile): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    this.cache = index;
  }

  /** Ingest a single KB document */
  async addDocument(doc: KBDocument): Promise<void> {
    const index = this.load();
    const vector = embed(doc.content);

    // Upsert — replace if same ID exists
    const existing = index.entries.findIndex((e) => e.id === doc.id);
    const entry: StoredEntry = {
      id: doc.id,
      vector,
      content: doc.content.slice(0, 8000),
      metadata: Object.fromEntries(
        Object.entries({ id: doc.id, ...doc.metadata })
          .map(([k, v]) => [k, String(v)])
      ),
    };

    if (existing >= 0) {
      index.entries[existing] = entry;
    } else {
      index.entries.push(entry);
      index.stats.total++;
    }

    index.stats.lastUpdated = new Date().toISOString();
    this.save(index);
    logger.info(`KB: indexed "${doc.id}" (${doc.source})`);
  }

  /** Ingest multiple documents */
  async addDocuments(docs: KBDocument[]): Promise<void> {
    for (const doc of docs) await this.addDocument(doc);
  }

  /**
   * Retrieve the most relevant documents for a query via cosine similarity.
   */
  async retrieve(
    query: string,
    options: {
      topK?: number;
      minScore?: number;
      filter?: Partial<Record<string, string>>;
    } = {}
  ): Promise<Array<{ content: string; score: number; metadata: Record<string, string> }>> {
    const index = this.load();
    const topK = options.topK ?? 8;
    const minScore = options.minScore ?? 0.3;
    const queryVec = embed(query);

    return index.entries
      .map((entry) => ({
        content: entry.content,
        score: cosineSimilarity(queryVec, entry.vector),
        metadata: entry.metadata,
      }))
      .filter((r) => {
        if (r.score < minScore) return false;
        if (!options.filter) return true;
        return Object.entries(options.filter).every(
          ([k, v]) => !v || r.metadata[k] === v
        );
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Count of documents in the index */
  async count(): Promise<number> {
    return this.load().entries.length;
  }

  /** List all document IDs */
  async listIds(): Promise<string[]> {
    return this.load().entries.map((e) => e.id);
  }

  /** Delete a document by ID */
  async deleteDocument(id: string): Promise<void> {
    const index = this.load();
    index.entries = index.entries.filter((e) => e.id !== id);
    index.stats.total = index.entries.length;
    this.save(index);
    logger.info(`KB: deleted "${id}"`);
  }

  /** Clear the entire index */
  async clear(): Promise<void> {
    this.cache = null;
    if (fs.existsSync(this.dataDir)) {
      fs.rmSync(this.dataDir, { recursive: true });
    }
    logger.info('KB: cleared');
  }

  getStats(): { dataDir: string; total: number; lastUpdated: string } {
    const index = this.load();
    return {
      dataDir: this.dataDir,
      total: index.entries.length,
      lastUpdated: index.stats.lastUpdated,
    };
  }
}

// ─── Context Builder ──────────────────────────────────────────────────────────

export function buildLocalKBContext(
  results: Array<{ content: string; score: number; metadata: Record<string, string> }>
): string {
  if (results.length === 0) return '';

  const grouped: Record<string, typeof results> = {};
  for (const r of results) {
    const src = r.metadata.source ?? 'unknown';
    if (!grouped[src]) grouped[src] = [];
    grouped[src].push(r);
  }

  const labels: Record<string, string> = {
    generated: 'Previously Generated Test Cases',
    jira: 'Jira Acceptance Criteria',
    confluence: 'Confluence Documentation',
    zephyr: 'Existing Zephyr Test Cases',
  };

  const lines = [
    '## Relevant Knowledge Base Context (Local)\n',
    '_Retrieved from your team\'s local knowledge base. Use to inform generation and avoid duplication._\n',
  ];

  for (const [src, items] of Object.entries(grouped)) {
    lines.push(`### ${labels[src] ?? src}`);
    for (const item of items) {
      const meta = item.metadata;
      const header = [
        meta.jira_issue_key && `Issue: ${meta.jira_issue_key}`,
        meta.feature_area && `Area: ${meta.feature_area}`,
        `Relevance: ${(item.score * 100).toFixed(0)}%`,
      ].filter(Boolean).join(' · ');
      lines.push(`\n_${header}_\n`);
      lines.push(item.content.slice(0, 1500));
      lines.push('');
    }
  }

  return lines.join('\n');
}

export async function retrieveLocalContextForIssue(
  db: IKnowledgeBase,
  issueKey: string,
  projectKey: string,
  featureArea?: string
): Promise<string> {
  const [exact, similar] = await Promise.all([
    db.retrieve(`test cases for ${issueKey}`, {
      topK: 4,
      filter: { jira_issue_key: issueKey },
    }).catch(() => []),
    db.retrieve(`acceptance criteria and tests for ${featureArea ?? projectKey}`, {
      topK: 6,
      minScore: 0.35,
      filter: { project_key: projectKey },
    }).catch(() => []),
  ]);

  const seen = new Set<string>();
  const all = [...exact, ...similar].filter((r) => {
    const k = r.content.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  logger.info(`Local KB: ${all.length} docs retrieved for ${issueKey}`);
  return buildLocalKBContext(all);
}
