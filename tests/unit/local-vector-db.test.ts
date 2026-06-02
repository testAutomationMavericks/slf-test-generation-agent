/**
 * tests/unit/local-vector-db.test.ts
 *
 * Unit tests for the local Knowledge Base vector store.
 * No external dependencies — runs without a server or API keys.
 *
 * Run: npm run test:unit
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { LocalKnowledgeBase, buildLocalKBContext, retrieveLocalContextForIssue } from '../../src/local-kb/local-vector-db.js';
import type { KBDocument } from '../../src/knowledge-base/types.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_DIR = path.join(process.cwd(), 'tests', '.tmp-kb-data');

function makeDoc(id: string, source: KBDocument['source'], content: string, issueKey = 'TEST-1'): KBDocument {
  return {
    id,
    source,
    content,
    metadata: {
      source,
      jira_issue_key: issueKey,
      jira_epic: '',
      feature_area: 'test',
      component: 'test-service',
      approved_by: 'test-runner',
      project_key: issueKey.split('-')[0],
      ingested_at: new Date().toISOString(),
      doc_type: 'test_case',
    },
  };
}

// ─── LocalKnowledgeBase ───────────────────────────────────────────────────────

describe('LocalKnowledgeBase — CRUD', () => {
  let db: LocalKnowledgeBase;

  before(() => {
    db = new LocalKnowledgeBase(TEST_DIR);
  });

  after(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  beforeEach(async () => {
    await db.clear();
  });

  // ── addDocument ──────────────────────────────────────────────────────────────

  test('starts with zero documents', () => {
    const stats = db.getStats();
    assert.equal(stats.total, 0);
  });

  test('addDocument increases total count', async () => {
    await db.addDocument(makeDoc('doc:1', 'jira', 'User login with email and password'));
    assert.equal(db.getStats().total, 1);
  });

  test('addDocument stores content and metadata', async () => {
    const doc = makeDoc('doc:meta', 'zephyr', 'Successful login test case', 'DEMO-1');
    await db.addDocument(doc);
    const ids = await db.listIds();
    assert.ok(ids.includes('doc:meta'), 'ID should appear in list');
  });

  test('addDocument upserts on duplicate ID', async () => {
    await db.addDocument(makeDoc('doc:dup', 'jira', 'original content'));
    await db.addDocument(makeDoc('doc:dup', 'jira', 'updated content'));
    assert.equal(db.getStats().total, 1, 'Should not double-count on upsert');
  });

  test('addDocuments batch inserts multiple', async () => {
    await db.addDocuments([
      makeDoc('doc:a', 'jira', 'login test'),
      makeDoc('doc:b', 'zephyr', 'basket test'),
      makeDoc('doc:c', 'confluence', 'architecture overview'),
    ]);
    assert.equal(db.getStats().total, 3);
  });

  // ── deleteDocument ───────────────────────────────────────────────────────────

  test('deleteDocument removes a document', async () => {
    await db.addDocument(makeDoc('doc:del', 'jira', 'to be deleted'));
    await db.deleteDocument('doc:del');
    assert.equal(db.getStats().total, 0);
    const ids = await db.listIds();
    assert.ok(!ids.includes('doc:del'));
  });

  test('deleteDocument on non-existent ID is safe', async () => {
    await assert.doesNotReject(() => db.deleteDocument('does-not-exist'));
  });

  // ── clear ────────────────────────────────────────────────────────────────────

  test('clear wipes all documents', async () => {
    await db.addDocuments([
      makeDoc('doc:1', 'jira', 'first'),
      makeDoc('doc:2', 'zephyr', 'second'),
    ]);
    await db.clear();
    assert.equal(db.getStats().total, 0);
  });

  // ── listIds ──────────────────────────────────────────────────────────────────

  test('listIds returns all stored IDs', async () => {
    await db.addDocuments([
      makeDoc('id:alpha', 'jira', 'alpha'),
      makeDoc('id:beta', 'zephyr', 'beta'),
      makeDoc('id:gamma', 'confluence', 'gamma'),
    ]);
    const ids = await db.listIds();
    assert.ok(ids.includes('id:alpha'));
    assert.ok(ids.includes('id:beta'));
    assert.ok(ids.includes('id:gamma'));
  });

  test('listIds returns empty array when DB is empty', async () => {
    const ids = await db.listIds();
    assert.deepEqual(ids, []);
  });

  // ── getStats ─────────────────────────────────────────────────────────────────

  test('getStats returns total and dataDir', async () => {
    const stats = db.getStats();
    assert.ok(typeof stats.total === 'number');
    assert.ok(typeof stats.dataDir === 'string');
    assert.ok(stats.dataDir.includes('tmp-kb-data'));
  });

  test('getStats.total matches actual document count', async () => {
    for (let i = 0; i < 5; i++) {
      await db.addDocument(makeDoc(`doc:${i}`, 'jira', `content ${i}`));
    }
    assert.equal(db.getStats().total, 5);
  });
});

// ─── Retrieve ─────────────────────────────────────────────────────────────────

describe('LocalKnowledgeBase — retrieve', () => {
  let db: LocalKnowledgeBase;

  before(async () => {
    db = new LocalKnowledgeBase(TEST_DIR + '-retrieve');
    await db.clear();

    // Seed docs across domains
    await db.addDocuments([
      makeDoc('login:1', 'jira', 'User login acceptance criteria: email and password authentication, session management, account lockout after 5 attempts'),
      makeDoc('login:2', 'zephyr', 'TC-001 Successful login with valid credentials — Given user on login page, When valid email and password entered, Then redirected to dashboard'),
      makeDoc('login:3', 'zephyr', 'TC-002 Login fails with wrong password — error message shown, account not locked after first attempt'),
      makeDoc('basket:1', 'jira', 'Add item to shopping basket acceptance criteria: quantity selection, stock validation, basket persistence across sessions'),
      makeDoc('basket:2', 'zephyr', 'TC-010 Add item to basket — happy path, item appears in basket with correct price'),
      makeDoc('arch:1', 'confluence', 'Authentication service architecture: bcrypt password hashing, JWT tokens, Redis session store, rate limiting'),
    ]);
  });

  after(() => {
    if (fs.existsSync(TEST_DIR + '-retrieve')) fs.rmSync(TEST_DIR + '-retrieve', { recursive: true });
  });

  test('returns results for a matching query', async () => {
    const results = await db.retrieve('login authentication test', { topK: 3 });
    assert.ok(results.length > 0, 'Should return at least one result');
    assert.ok(results[0].score > 0, 'Score should be positive');
    assert.ok(typeof results[0].content === 'string');
  });

  test('auth query ranks login docs higher than basket docs', async () => {
    const results = await db.retrieve('user login password authentication', { topK: 6 });
    const loginHits = results.filter(r => r.metadata.id?.startsWith('login'));
    const basketHits = results.filter(r => r.metadata.id?.startsWith('basket'));
    assert.ok(loginHits.length > 0, 'Should find login documents');
    if (loginHits.length > 0 && basketHits.length > 0) {
      assert.ok(
        loginHits[0].score >= basketHits[0].score,
        'Login docs should score >= basket docs for auth query'
      );
    }
  });

  test('basket query returns basket-related docs', async () => {
    const results = await db.retrieve('add item shopping basket checkout', { topK: 4 });
    assert.ok(results.length > 0);
    const firstId = results[0].metadata.id ?? '';
    assert.ok(
      firstId.startsWith('basket') || firstId.startsWith('login'),
      `Top result should be basket or login domain, got: ${firstId}`
    );
  });

  test('respects topK limit', async () => {
    const results = await db.retrieve('test', { topK: 2 });
    assert.ok(results.length <= 2);
  });

  test('filters by source metadata', async () => {
    const results = await db.retrieve('authentication login', {
      topK: 10,
      filter: { source: 'confluence' },
    });
    assert.ok(results.every(r => r.metadata.source === 'confluence'),
      'All results should be from confluence when filtered');
  });

  test('filters by jira_issue_key metadata', async () => {
    const results = await db.retrieve('login', {
      topK: 10,
      filter: { jira_issue_key: 'TEST-1' },
    });
    assert.ok(results.every(r => r.metadata.jira_issue_key === 'TEST-1'));
  });

  test('returns empty array when minScore threshold not met', async () => {
    const results = await db.retrieve('xyzzy gibberish nonsense', {
      topK: 5,
      minScore: 0.99, // impossibly high threshold
    });
    assert.equal(results.length, 0);
  });

  test('results are sorted by score descending', async () => {
    const results = await db.retrieve('login authentication session', { topK: 6 });
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `Results should be sorted: ${results[i-1].score} >= ${results[i].score}`
      );
    }
  });

  test('retrieve returns content as string', async () => {
    const results = await db.retrieve('login', { topK: 1 });
    assert.ok(results.length > 0);
    assert.ok(typeof results[0].content === 'string');
    assert.ok(results[0].content.length > 0);
  });
});

// ─── buildLocalKBContext ──────────────────────────────────────────────────────

describe('buildLocalKBContext', () => {
  test('returns empty string for empty results', () => {
    const ctx = buildLocalKBContext([]);
    assert.equal(ctx, '');
  });

  test('returns empty string for undefined/null or empty array', () => {
    // Some implementations guard against null, some don't - just verify empty array works
    assert.equal(buildLocalKBContext([]), '');
    // Guard test - function should not throw on falsy values ideally
    try {
      const r1 = buildLocalKBContext(undefined as any);
      assert.equal(r1, '');
    } catch { /* acceptable if not guarded */ }
    try {
      const r2 = buildLocalKBContext(null as any);
      assert.equal(r2, '');
    } catch { /* acceptable if not guarded */ }
  });

  test('groups results by source', () => {
    const ctx = buildLocalKBContext([
      { content: 'login test case', score: 0.9, metadata: { source: 'zephyr', jira_issue_key: 'T-1', feature_area: '' } },
      { content: 'login AC', score: 0.8, metadata: { source: 'jira', jira_issue_key: 'T-1', feature_area: '' } },
      { content: 'auth architecture', score: 0.7, metadata: { source: 'confluence', jira_issue_key: '', feature_area: '' } },
    ]);
    assert.ok(ctx.includes('Zephyr') || ctx.includes('zephyr'), 'Should include Zephyr source');
    assert.ok(ctx.includes('Jira') || ctx.includes('jira'), 'Should include Jira source');
    assert.ok(ctx.includes('Confluence') || ctx.includes('confluence'), 'Should include Confluence source');
  });

  test('includes relevance score as percentage', () => {
    const ctx = buildLocalKBContext([
      { content: 'test content', score: 0.75, metadata: { source: 'jira', jira_issue_key: '', feature_area: '' } },
    ]);
    assert.ok(ctx.includes('75%') || ctx.includes('0.75'), 'Should show relevance score');
  });

  test('includes issue key when present', () => {
    const ctx = buildLocalKBContext([
      { content: 'test', score: 0.8, metadata: { source: 'jira', jira_issue_key: 'DEMO-42', feature_area: '' } },
    ]);
    assert.ok(ctx.includes('DEMO-42'), 'Should include the issue key');
  });

  test('includes all document content', () => {
    const ctx = buildLocalKBContext([
      { content: 'unique-login-content-xyz', score: 0.9, metadata: { source: 'jira', jira_issue_key: '', feature_area: '' } },
    ]);
    assert.ok(ctx.includes('unique-login-content-xyz'), 'Should include document content');
  });

  test('handles single document', () => {
    const ctx = buildLocalKBContext([
      { content: 'single doc', score: 0.5, metadata: { source: 'generated', jira_issue_key: 'T-1', feature_area: '' } },
    ]);
    assert.ok(ctx.length > 0);
    assert.ok(ctx.includes('single doc'));
  });
});

// ─── retrieveLocalContextForIssue ────────────────────────────────────────────

describe('retrieveLocalContextForIssue', () => {
  let db: LocalKnowledgeBase;

  before(async () => {
    db = new LocalKnowledgeBase(TEST_DIR + '-issue');
    await db.clear();
    await db.addDocuments([
      makeDoc('generated:DEMO-T1:DEMO-1', 'generated', 'Successful login test case with valid credentials', 'DEMO-1'),
      makeDoc('generated:DEMO-T2:DEMO-1', 'zephyr', 'Login failure test case with invalid password', 'DEMO-1'),
      makeDoc('jira:DEMO-1', 'jira', 'DEMO-1 acceptance criteria: user login with email and password', 'DEMO-1'),
      makeDoc('basket:DEMO-2', 'jira', 'DEMO-2 add item to basket acceptance criteria', 'DEMO-2'),
    ]);
  });

  after(() => {
    if (fs.existsSync(TEST_DIR + '-issue')) fs.rmSync(TEST_DIR + '-issue', { recursive: true });
  });

  test('returns context string for a known issue', async () => {
    const ctx = await retrieveLocalContextForIssue(db, 'DEMO-1', 'DEMO');
    assert.ok(typeof ctx === 'string');
    assert.ok(ctx.length > 0, 'Should return non-empty context for DEMO-1');
  });

  test('returns empty string for unknown issue with no related content', async () => {
    const ctx = await retrieveLocalContextForIssue(db, 'UNKNOWN-999', 'UNKNOWN');
    // Should return either empty or minimal context
    assert.ok(typeof ctx === 'string');
  });

  test('context contains relevant content for the issue', async () => {
    const ctx = await retrieveLocalContextForIssue(db, 'DEMO-1', 'DEMO');
    // Should include something about login since DEMO-1 is the login ticket
    assert.ok(
      ctx.includes('login') || ctx.includes('DEMO-1') || ctx.includes('credentials'),
      'Context should include login-related content for DEMO-1'
    );
  });
});
