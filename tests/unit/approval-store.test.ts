/**
 * tests/unit/approval-store.test.ts
 *
 * Unit tests for src/approvals/approval-store.ts
 * Tests LocalApprovalStore (file-based) and createApprovalStore factory.
 *
 * Run: npm run test:unit
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  LocalApprovalStore,
  createApprovalStore,
} from '../../src/approvals/approval-store.js';
import type { ApprovalRequest, ApprovalTestCase } from '../../src/approvals/approval-store.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_DIR = path.join(process.cwd(), 'tests', '.tmp-approvals');
const TEST_FILE = path.join(TEST_DIR, 'approvals.json');

function makeTestCase(id: number): ApprovalTestCase {
  return {
    id,
    name: `Test Case ${id}`,
    type: 'Functional',
    priority: 'High',
    precondition: 'User is logged in',
    steps: [
      { description: 'Navigate to page', expectedResult: 'Page loads' },
    ],
    content: `## TC-${id}\nTest content`,
    outcome: 'Feature works as expected',
  };
}

function makeApproval(id: string, requestedAt = '2026-01-01T10:00:00.000Z'): ApprovalRequest {
  return {
    id,
    issueKey: 'DEMO-1',
    issueSummary: 'User Login',
    projectKey: 'DEMO',
    folder: 'Auth Tests',
    requestedBy: 'qa-engineer',
    requestedAt,
    testCases: [makeTestCase(1), makeTestCase(2)],
    status: 'pending',
  };
}

// ─── LocalApprovalStore ───────────────────────────────────────────────────────

describe('LocalApprovalStore — backend', () => {
  test('backend property is "local"', () => {
    const store = new LocalApprovalStore(TEST_FILE);
    assert.equal(store.backend, 'local');
  });
});

describe('LocalApprovalStore — CRUD', () => {
  let store: LocalApprovalStore;

  before(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new LocalApprovalStore(TEST_FILE);
  });

  after(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    // reset cache by creating a fresh instance
    store = new LocalApprovalStore(TEST_FILE);
  });

  test('load returns null for unknown id', async () => {
    const result = await store.load('apr-does-not-exist');
    assert.equal(result, null);
  });

  test('save then load returns the same approval', async () => {
    const approval = makeApproval('apr-001');
    await store.save(approval);
    const loaded = await store.load('apr-001');
    assert.deepEqual(loaded, approval);
  });

  test('save overwrites an existing approval', async () => {
    const original = makeApproval('apr-001');
    await store.save(original);

    const updated = { ...original, status: 'approved' as const, approvedBy: 'qa-lead' };
    await store.save(updated);

    const loaded = await store.load('apr-001');
    assert.equal(loaded?.status, 'approved');
    assert.equal(loaded?.approvedBy, 'qa-lead');
  });

  test('loadAll returns empty array when no approvals exist', async () => {
    const all = await store.loadAll();
    assert.deepEqual(all, []);
  });

  test('loadAll returns all saved approvals', async () => {
    await store.save(makeApproval('apr-001'));
    await store.save(makeApproval('apr-002'));
    const all = await store.loadAll();
    assert.equal(all.length, 2);
  });

  test('loadAll sorts by requestedAt descending (newest first)', async () => {
    await store.save(makeApproval('apr-older', '2026-01-01T08:00:00.000Z'));
    await store.save(makeApproval('apr-newer', '2026-01-02T08:00:00.000Z'));
    const all = await store.loadAll();
    assert.equal(all[0].id, 'apr-newer');
    assert.equal(all[1].id, 'apr-older');
  });

  test('delete removes the approval', async () => {
    await store.save(makeApproval('apr-001'));
    await store.delete('apr-001');
    const result = await store.load('apr-001');
    assert.equal(result, null);
  });

  test('delete on non-existent id does not throw', async () => {
    await assert.doesNotReject(() => store.delete('apr-ghost'));
  });

  test('data persists to disk and survives a new store instance', async () => {
    const approval = makeApproval('apr-persist');
    await store.save(approval);

    const fresh = new LocalApprovalStore(TEST_FILE);
    const loaded = await fresh.load('apr-persist');
    assert.deepEqual(loaded, approval);
  });

  test('returns all test cases in the approval', async () => {
    const approval = makeApproval('apr-tc');
    await store.save(approval);
    const loaded = await store.load('apr-tc');
    assert.equal(loaded?.testCases.length, 2);
    assert.equal(loaded?.testCases[0].name, 'Test Case 1');
  });
});

// ─── createApprovalStore factory ─────────────────────────────────────────────

describe('createApprovalStore', () => {
  test('returns LocalApprovalStore when no databaseUrl provided', () => {
    const store = createApprovalStore({ filePath: TEST_FILE });
    assert.equal(store.backend, 'local');
  });

  test('returns LocalApprovalStore when kbBackend is not pgvector', () => {
    const store = createApprovalStore({
      filePath: TEST_FILE,
      databaseUrl: 'postgresql://localhost/db',
      kbBackend: 'local',
    });
    assert.equal(store.backend, 'local');
  });

  test('returns PgApprovalStore when kbBackend is pgvector and databaseUrl set', () => {
    const store = createApprovalStore({
      filePath: TEST_FILE,
      databaseUrl: 'postgresql://localhost/db',
      kbBackend: 'pgvector',
    });
    assert.equal(store.backend, 'postgres');
  });

  test('returns LocalApprovalStore when kbBackend is pgvector but no databaseUrl', () => {
    const store = createApprovalStore({
      filePath: TEST_FILE,
      kbBackend: 'pgvector',
    });
    assert.equal(store.backend, 'local');
  });
});
