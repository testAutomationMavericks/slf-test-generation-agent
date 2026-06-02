/**
 * src/mocks/zephyr-server.ts
 *
 * Mock MCP server that behaves like the SmartBear MCP (Zephyr Scale).
 * Pre-populated with sample test cases so you can see retrieval and
 * gap analysis working before connecting real Zephyr credentials.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Sample Test Cases ────────────────────────────────────────────────────────

interface MockTestCase {
  key: string;
  name: string;
  objective: string;
  precondition: string;
  priority: { name: string };
  status: { name: string };
  folder: { name: string };
  projectKey: string;
  linkedIssues: string[];
  steps: Array<{ description: string; expectedResult: string }>;
  labels: string[];
  createdOn: string;
}

const MOCK_TEST_CASES: Record<string, MockTestCase> = {
  'DEMO-T1': {
    key: 'DEMO-T1',
    name: 'Successful login with valid credentials',
    objective: 'Verify user can log in with correct email and password',
    precondition: 'User account exists with email: test@demo.com, password: Test1234!',
    priority: { name: 'High' },
    status: { name: 'Approved' },
    folder: { name: 'Authentication/Login' },
    projectKey: 'DEMO',
    linkedIssues: ['DEMO-1'],
    labels: ['smoke', 'authentication'],
    createdOn: '2026-03-01T10:00:00Z',
    steps: [
      { description: 'Navigate to /login', expectedResult: 'Login page is displayed' },
      { description: 'Enter email: test@demo.com', expectedResult: 'Email field populated' },
      { description: 'Enter password: Test1234!', expectedResult: 'Password field populated (masked)' },
      { description: 'Click "Sign In"', expectedResult: 'User is redirected to /dashboard' },
    ],
  },
  'DEMO-T2': {
    key: 'DEMO-T2',
    name: 'Login fails with incorrect password',
    objective: 'Verify correct error message on wrong password',
    precondition: 'User account exists with email: test@demo.com',
    priority: { name: 'High' },
    status: { name: 'Approved' },
    folder: { name: 'Authentication/Login' },
    projectKey: 'DEMO',
    linkedIssues: ['DEMO-1'],
    labels: ['negative', 'authentication'],
    createdOn: '2026-03-01T10:30:00Z',
    steps: [
      { description: 'Navigate to /login', expectedResult: 'Login page is displayed' },
      { description: 'Enter valid email and wrong password', expectedResult: 'Fields populated' },
      { description: 'Click "Sign In"', expectedResult: 'Error: "Invalid email or password" shown; user stays on /login' },
    ],
  },
  'DEMO-T3': {
    key: 'DEMO-T3',
    name: 'Account lockout after 5 failed attempts',
    objective: 'Verify account is locked after 5 consecutive failed logins',
    precondition: 'User account exists, no previous failed attempts',
    priority: { name: 'Critical' },
    status: { name: 'Approved' },
    folder: { name: 'Authentication/Security' },
    projectKey: 'DEMO',
    linkedIssues: ['DEMO-1'],
    labels: ['security', 'authentication'],
    createdOn: '2026-03-02T09:00:00Z',
    steps: [
      { description: 'Attempt login with wrong password 5 times', expectedResult: 'Each attempt shows "Invalid email or password"' },
      { description: 'Attempt 6th login', expectedResult: 'Account locked message shown; lockout lasts 15 minutes' },
      { description: 'Wait 15 minutes and try valid credentials', expectedResult: 'Login succeeds' },
    ],
  },
  'DEMO-T4': {
    key: 'DEMO-T4',
    name: 'Add single item to empty basket',
    objective: 'Verify item is added to basket with correct quantity and success message',
    precondition: 'User is logged in; basket is empty; product PROD-001 exists with stock > 0',
    priority: { name: 'Critical' },
    status: { name: 'Approved' },
    folder: { name: 'Basket/Add Item' },
    projectKey: 'DEMO',
    linkedIssues: ['DEMO-2'],
    labels: ['smoke', 'basket'],
    createdOn: '2026-03-05T14:00:00Z',
    steps: [
      { description: 'Navigate to product page for PROD-001', expectedResult: 'Product page loads; "Add to Basket" button enabled' },
      { description: 'Click "Add to Basket"', expectedResult: 'Success toast: "Added to basket"; basket count shows 1' },
      { description: 'Navigate to /basket', expectedResult: 'PROD-001 appears with quantity 1 and correct price' },
    ],
  },
  'DEMO-T5': {
    key: 'DEMO-T5',
    name: 'Increase quantity when adding duplicate item',
    objective: 'Verify adding an existing item increments quantity instead of duplicating',
    precondition: 'User is logged in; basket contains PROD-001 with quantity 1',
    priority: { name: 'High' },
    status: { name: 'Approved' },
    folder: { name: 'Basket/Add Item' },
    projectKey: 'DEMO',
    linkedIssues: ['DEMO-2'],
    labels: ['basket'],
    createdOn: '2026-03-05T15:00:00Z',
    steps: [
      { description: 'Add PROD-001 to basket again', expectedResult: 'Basket shows PROD-001 with quantity 2 (not two separate lines)' },
    ],
  },
};

// Map issue keys to test case keys
const ISSUE_TEST_MAP: Record<string, string[]> = {
  'DEMO-1': ['DEMO-T1', 'DEMO-T2', 'DEMO-T3'],
  'DEMO-2': ['DEMO-T4', 'DEMO-T5'],
  'DEMO-3': [], // No tests yet — gap!
  'DEMO-4': [], // No tests yet — gap!
};

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mock-zephyr-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'zephyr_get_test_cases',
      description: 'Get test cases for a project',
      inputSchema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string' },
          maxResults: { type: 'number' },
          folder: { type: 'string' },
        },
        required: ['projectKey'],
      },
    },
    {
      name: 'zephyr_get_test_case',
      description: 'Get a test case by key',
      inputSchema: {
        type: 'object',
        properties: { testCaseKey: { type: 'string' } },
        required: ['testCaseKey'],
      },
    },
    {
      name: 'zephyr_get_test_cases_by_issue',
      description: 'Get all test cases linked to a Jira issue',
      inputSchema: {
        type: 'object',
        properties: { issueKey: { type: 'string' } },
        required: ['issueKey'],
      },
    },
    {
      name: 'zephyr_create_test_case',
      description: 'Create a new test case in Zephyr Scale',
      inputSchema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string' },
          name: { type: 'string' },
          objective: { type: 'string' },
          precondition: { type: 'string' },
          priority: { type: 'string' },
          folder: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                expectedResult: { type: 'string' },
              },
            },
          },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['projectKey', 'name'],
      },
    },
    {
      name: 'zephyr_get_test_cycles',
      description: 'Get test cycles for a project',
      inputSchema: {
        type: 'object',
        properties: { projectKey: { type: 'string' } },
        required: ['projectKey'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

  if (name === 'zephyr_get_test_cases') {
    const projectKey = args?.projectKey as string;
    const all = Object.values(MOCK_TEST_CASES).filter((t) => t.projectKey === projectKey);
    const maxResults = (args?.maxResults as number) ?? 50;
    return { content: [{ type: 'text', text: JSON.stringify(all.slice(0, maxResults), null, 2) }] };
  }

  if (name === 'zephyr_get_test_case') {
    const key = (args?.testCaseKey as string)?.toUpperCase();
    const tc = MOCK_TEST_CASES[key];
    if (!tc) return { content: [{ type: 'text', text: `Test case ${key} not found` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(tc, null, 2) }] };
  }

  if (name === 'zephyr_get_test_cases_by_issue') {
    const issueKey = (args?.issueKey as string)?.toUpperCase();
    const keys = ISSUE_TEST_MAP[issueKey] ?? [];
    const testCases = keys.map((k) => MOCK_TEST_CASES[k]).filter(Boolean);
    return { content: [{ type: 'text', text: JSON.stringify(testCases, null, 2) }] };
  }

  if (name === 'zephyr_create_test_case') {
    const newKey = `DEMO-T${Object.keys(MOCK_TEST_CASES).length + 1}`;
    const created: MockTestCase = {
      key: newKey,
      name: args?.name as string,
      objective: args?.objective as string ?? '',
      precondition: args?.precondition as string ?? '',
      priority: { name: (args?.priority as string) ?? 'Medium' },
      status: { name: 'Draft' },
      folder: { name: (args?.folder as string) ?? 'General' },
      projectKey: args?.projectKey as string,
      linkedIssues: [],
      labels: (args?.labels as string[]) ?? [],
      createdOn: new Date().toISOString(),
      steps: (args?.steps as Array<{ description: string; expectedResult: string }>) ?? [],
    };
    MOCK_TEST_CASES[newKey] = created;

    // Link to the issue so zephyr_get_test_cases_by_issue returns it
    const linkedIssueKey = (args?.labels as string[] ?? [])
      .find(l => /^[A-Za-z]+-\d+$/i.test(l))?.toUpperCase();
    if (linkedIssueKey) {
      if (!ISSUE_TEST_MAP[linkedIssueKey]) ISSUE_TEST_MAP[linkedIssueKey] = [];
      ISSUE_TEST_MAP[linkedIssueKey].push(newKey);
      created.linkedIssues = [linkedIssueKey];
    }

    console.error(`[mock-zephyr] Created ${newKey}: ${created.name}${linkedIssueKey ? ' → linked to ' + linkedIssueKey : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify({ created, message: `Test case ${newKey} created successfully` }, null, 2) }] };
  }

  if (name === 'zephyr_get_test_cycles') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify([
          { key: 'DEMO-C1', name: 'Sprint 12 Regression', status: 'In Progress', projectKey: args?.projectKey },
          { key: 'DEMO-C2', name: 'Auth Release Cycle', status: 'Done', projectKey: args?.projectKey },
        ], null, 2),
      }],
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mock-zephyr] Server started\n');
}

main().catch((e) => { process.stderr.write(`[mock-zephyr] Error: ${e}\n`); process.exit(1); });
