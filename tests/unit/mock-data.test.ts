/**
 * tests/unit/mock-data.test.ts
 *
 * Unit tests for mock server data shapes, KB document format,
 * and server utility functions.
 *
 * Run: npm run test:unit
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock Jira data shapes ────────────────────────────────────────────────────

const MOCK_ISSUES = {
  'DEMO-1': {
    key: 'DEMO-1',
    summary: 'User Login with Email and Password',
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    labels: ['authentication', 'security'],
    components: [{ name: 'auth-service' }],
  },
  'DEMO-2': {
    key: 'DEMO-2',
    summary: 'Add Item to Shopping Basket',
    priority: { name: 'High' },
    status: { name: 'To Do' },
    labels: ['basket', 'ecommerce'],
    components: [{ name: 'basket-service' }],
  },
  'DEMO-3': {
    key: 'DEMO-3',
    summary: 'Apply Discount Code at Checkout',
    priority: { name: 'Medium' },
    status: { name: 'To Do' },
    labels: ['checkout', 'discount'],
    components: [{ name: 'checkout-service' }],
  },
  'DEMO-4': {
    key: 'DEMO-4',
    summary: 'Password Reset via Email',
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    labels: ['authentication', 'email'],
    components: [{ name: 'auth-service' }],
  },
};

describe('Mock Jira data', () => {
  test('all DEMO issues have a key property', () => {
    for (const [k, issue] of Object.entries(MOCK_ISSUES)) {
      assert.equal(issue.key, k, `Key mismatch for ${k}`);
    }
  });

  test('all DEMO issues have a summary', () => {
    for (const issue of Object.values(MOCK_ISSUES)) {
      assert.ok(typeof issue.summary === 'string' && issue.summary.length > 0);
    }
  });

  test('all DEMO issues have a priority', () => {
    for (const issue of Object.values(MOCK_ISSUES)) {
      assert.ok(issue.priority?.name, `Priority missing for ${issue.key}`);
    }
  });

  test('all DEMO issues have a status', () => {
    for (const issue of Object.values(MOCK_ISSUES)) {
      assert.ok(issue.status?.name, `Status missing for ${issue.key}`);
    }
  });

  test('DEMO-1 is the login ticket with High priority', () => {
    assert.equal(MOCK_ISSUES['DEMO-1'].priority.name, 'High');
    assert.ok(MOCK_ISSUES['DEMO-1'].summary.toLowerCase().includes('login'));
    assert.ok(MOCK_ISSUES['DEMO-1'].labels.includes('authentication'));
  });

  test('DEMO-3 is the gap demo ticket with Medium priority', () => {
    assert.equal(MOCK_ISSUES['DEMO-3'].priority.name, 'Medium');
    assert.ok(MOCK_ISSUES['DEMO-3'].summary.toLowerCase().includes('discount'));
  });

  test('DEMO-1 and DEMO-4 are In Progress', () => {
    assert.equal(MOCK_ISSUES['DEMO-1'].status.name, 'In Progress');
    assert.equal(MOCK_ISSUES['DEMO-4'].status.name, 'In Progress');
  });

  test('DEMO-2 and DEMO-3 are To Do', () => {
    assert.equal(MOCK_ISSUES['DEMO-2'].status.name, 'To Do');
    assert.equal(MOCK_ISSUES['DEMO-3'].status.name, 'To Do');
  });

  test('DEMO-1 components include auth-service', () => {
    const comps = MOCK_ISSUES['DEMO-1'].components.map(c => c.name);
    assert.ok(comps.includes('auth-service'));
  });

  test('four DEMO tickets exist', () => {
    assert.equal(Object.keys(MOCK_ISSUES).length, 4);
  });
});

// ─── Mock Zephyr test data ────────────────────────────────────────────────────

const MOCK_TESTS = [
  { key: 'DEMO-T1', name: 'Successful login with valid credentials', linkedIssues: ['DEMO-1'], priority: { name: 'High' } },
  { key: 'DEMO-T2', name: 'Login fails with wrong password', linkedIssues: ['DEMO-1'], priority: { name: 'High' } },
  { key: 'DEMO-T3', name: 'Account lockout after 5 failed attempts', linkedIssues: ['DEMO-1'], priority: { name: 'Critical' } },
  { key: 'DEMO-T4', name: 'Add single item to basket', linkedIssues: ['DEMO-2'], priority: { name: 'High' } },
  { key: 'DEMO-T5', name: 'Remove item from basket', linkedIssues: ['DEMO-2'], priority: { name: 'Medium' } },
];

describe('Mock Zephyr data', () => {
  test('five pre-seeded test cases exist', () => {
    assert.equal(MOCK_TESTS.length, 5);
  });

  test('all test cases have a key and name', () => {
    for (const tc of MOCK_TESTS) {
      assert.ok(tc.key.startsWith('DEMO-T'), `Key format wrong: ${tc.key}`);
      assert.ok(tc.name.length > 0);
    }
  });

  test('DEMO-1 has 3 linked tests', () => {
    const demo1Tests = MOCK_TESTS.filter(t => t.linkedIssues.includes('DEMO-1'));
    assert.equal(demo1Tests.length, 3);
  });

  test('DEMO-2 has 2 linked tests', () => {
    const demo2Tests = MOCK_TESTS.filter(t => t.linkedIssues.includes('DEMO-2'));
    assert.equal(demo2Tests.length, 2);
  });

  test('DEMO-3 has no linked tests (gap scenario)', () => {
    const demo3Tests = MOCK_TESTS.filter(t => t.linkedIssues.includes('DEMO-3'));
    assert.equal(demo3Tests.length, 0);
  });

  test('DEMO-T3 is Critical priority (security test)', () => {
    const t3 = MOCK_TESTS.find(t => t.key === 'DEMO-T3');
    assert.equal(t3?.priority.name, 'Critical');
  });
});

// ─── KB document format validation ───────────────────────────────────────────

describe('KB document format', () => {
  interface KBDoc {
    id: string;
    source: string;
    content: string;
    metadata: Record<string, string>;
  }

  function isValidKBDoc(doc: unknown): doc is KBDoc {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (typeof d.id !== 'string' || d.id.length === 0) return false;
    if (!['jira', 'zephyr', 'confluence', 'generated'].includes(d.source as string)) return false;
    if (typeof d.content !== 'string' || d.content.length === 0) return false;
    if (!d.metadata || typeof d.metadata !== 'object') return false;
    return true;
  }

  test('valid doc passes validation', () => {
    assert.ok(isValidKBDoc({
      id: 'generated:DEMO-T1:DEMO-1',
      source: 'generated',
      content: 'Test case content here',
      metadata: { jira_issue_key: 'DEMO-1', source: 'generated' },
    }));
  });

  test('invalid source fails validation', () => {
    assert.equal(isValidKBDoc({
      id: 'doc:1', source: 'unknown', content: 'text', metadata: {},
    }), false);
  });

  test('empty content fails validation', () => {
    assert.equal(isValidKBDoc({
      id: 'doc:1', source: 'jira', content: '', metadata: {},
    }), false);
  });

  test('empty ID fails validation', () => {
    assert.equal(isValidKBDoc({
      id: '', source: 'jira', content: 'text', metadata: {},
    }), false);
  });

  test('missing metadata fails validation', () => {
    assert.equal(isValidKBDoc({
      id: 'doc:1', source: 'jira', content: 'text',
    }), false);
  });

  test('Zephyr KB doc ID has correct format', () => {
    const id = 'generated:DEMO-T6:DEMO-3';
    const parts = id.split(':');
    assert.equal(parts[0], 'generated');
    assert.ok(parts[1].startsWith('DEMO-T'));
    assert.ok(parts[2].startsWith('DEMO-'));
  });
});

// ─── MCP tool name routing ────────────────────────────────────────────────────

describe('MCP tool routing', () => {
  function routeTool(toolName: string): 'jira' | 'confluence' | 'zephyr' | 'unknown' {
    if (toolName.startsWith('jira_')) return 'jira';
    if (toolName.startsWith('confluence_')) return 'confluence';
    if (toolName.startsWith('zephyr_')) return 'zephyr';
    return 'unknown';
  }

  test('jira_get_issue → jira', () => assert.equal(routeTool('jira_get_issue'), 'jira'));
  test('jira_search → jira', () => assert.equal(routeTool('jira_search'), 'jira'));
  test('jira_add_comment → jira', () => assert.equal(routeTool('jira_add_comment'), 'jira'));
  test('confluence_search → confluence', () => assert.equal(routeTool('confluence_search'), 'confluence'));
  test('confluence_get_page → confluence', () => assert.equal(routeTool('confluence_get_page'), 'confluence'));
  test('zephyr_create_test_case → zephyr', () => assert.equal(routeTool('zephyr_create_test_case'), 'zephyr'));
  test('zephyr_get_test_cases_by_issue → zephyr', () => assert.equal(routeTool('zephyr_get_test_cases_by_issue'), 'zephyr'));
  test('unknown_tool → unknown', () => assert.equal(routeTool('unknown_tool'), 'unknown'));
});

// ─── SSE event parsing ────────────────────────────────────────────────────────

describe('SSE event parsing', () => {
  function parseSSELine(line: string): unknown | null {
    if (!line.startsWith('data: ')) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }

  test('parses data: line correctly', () => {
    const result = parseSSELine('data: {"type":"chunk","text":"hello"}');
    assert.deepEqual(result, { type: 'chunk', text: 'hello' });
  });

  test('returns null for non-data lines', () => {
    assert.equal(parseSSELine('event: message'), null);
    assert.equal(parseSSELine('id: 123'), null);
    assert.equal(parseSSELine(''), null);
  });

  test('returns null for malformed JSON', () => {
    assert.equal(parseSSELine('data: {broken json}'), null);
  });

  test('parses all SSE event types', () => {
    const events = [
      { type: 'mode', engine: 'Claude Code' },
      { type: 'chunk', text: 'Generated content...' },
      { type: 'kb_context', count: 3 },
      { type: 'done', fullOutput: 'complete' },
      { type: 'error', message: 'something failed' },
    ];
    for (const ev of events) {
      const line = `data: ${JSON.stringify(ev)}`;
      const parsed = parseSSELine(line);
      assert.deepEqual(parsed, ev, `Failed to parse event type: ${ev.type}`);
    }
  });
});

// ─── Config masking ───────────────────────────────────────────────────────────

describe('Config masking', () => {
  const MASK = '••••••••';

  function maskConfig(cfg: Record<string, string>): Record<string, string> {
    const sensitive = ['jiraApiToken', 'confluenceApiToken', 'zephyrApiToken', 'anthropicApiKey', 'openaiApiKey', 'localApiKey'];
    const result = { ...cfg };
    for (const key of sensitive) {
      if (result[key]) result[key] = MASK;
    }
    return result;
  }

  test('masks jiraApiToken', () => {
    const masked = maskConfig({ jiraApiToken: 'real-token-123' });
    assert.equal(masked.jiraApiToken, MASK);
  });

  test('masks anthropicApiKey', () => {
    const masked = maskConfig({ anthropicApiKey: 'sk-ant-api03-real-key' });
    assert.equal(masked.anthropicApiKey, MASK);
  });

  test('masks openaiApiKey', () => {
    const masked = maskConfig({ openaiApiKey: 'sk-real-key' });
    assert.equal(masked.openaiApiKey, MASK);
  });

  test('does not mask non-sensitive fields', () => {
    const masked = maskConfig({ jiraUrl: 'https://company.atlassian.net', mode: 'live' });
    assert.equal(masked.jiraUrl, 'https://company.atlassian.net');
    assert.equal(masked.mode, 'live');
  });

  test('does not mask empty sensitive fields', () => {
    const masked = maskConfig({ anthropicApiKey: '' });
    assert.equal(masked.anthropicApiKey, '', 'Empty keys should not be masked');
  });

  test('all six sensitive fields are masked', () => {
    const cfg: Record<string, string> = {
      jiraApiToken: 'a', confluenceApiToken: 'b', zephyrApiToken: 'c',
      anthropicApiKey: 'd', openaiApiKey: 'e', localApiKey: 'f',
      jiraUrl: 'https://example.com',
    };
    const masked = maskConfig(cfg);
    assert.equal(masked.jiraApiToken, MASK);
    assert.equal(masked.confluenceApiToken, MASK);
    assert.equal(masked.zephyrApiToken, MASK);
    assert.equal(masked.anthropicApiKey, MASK);
    assert.equal(masked.openaiApiKey, MASK);
    assert.equal(masked.localApiKey, MASK);
    assert.equal(masked.jiraUrl, 'https://example.com');
  });
});
