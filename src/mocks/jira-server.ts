/**
 * src/mocks/jira-server.ts
 *
 * Mock MCP server that behaves like mcp-atlassian (Jira).
 * Serves realistic sample data so you can run the agent without
 * real Atlassian credentials.
 *
 * Swap to the real server by changing the command in .mcp.json:
 *   "command": "uvx"  instead of  "command": "node"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ─── Sample Data ──────────────────────────────────────────────────────────────

const MOCK_ISSUES: Record<string, object> = {
  'DEMO-1': {
    key: 'DEMO-1',
    summary: 'User Login with Email and Password',
    description: `## Acceptance Criteria

**Given** a user is on the login page
**When** they enter a valid registered email and correct password
**Then** they should be redirected to the dashboard

**Given** a user enters an incorrect password
**When** they submit the login form
**Then** they should see "Invalid email or password" and remain on the login page

**Given** a user fails to login 5 consecutive times
**When** they attempt a 6th login
**Then** their account should be locked for 15 minutes and they should see a lockout message

**Given** a user checks "Remember me"
**When** they close and reopen the browser
**Then** they should still be logged in (token valid for 30 days)

**Non-functional:**
- Login response time must be under 500ms at p95
- Passwords must be hashed with bcrypt, min 12 rounds`,
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    assignee: { displayName: 'Alice Smith' },
    labels: ['authentication', 'security'],
    components: [{ name: 'auth-service' }],
    epic: { key: 'DEMO-10', summary: 'Authentication Epic' },
    created: '2026-04-01T09:00:00Z',
    updated: '2026-05-10T14:30:00Z',
  },
  'DEMO-2': {
    key: 'DEMO-2',
    summary: 'Add Item to Shopping Basket',
    description: `## Acceptance Criteria

**Given** a logged-in user is on a product page
**When** they click "Add to Basket"
**Then** the item should appear in their basket with quantity 1 and a success toast should appear

**Given** an item is already in the basket
**When** the user adds the same item again
**Then** the quantity should increment by 1 (not create a duplicate line)

**Given** a product has limited stock (e.g. 3 remaining)
**When** the user tries to add a 4th unit
**Then** they should see "Only 3 left in stock" and the quantity should cap at 3

**Given** a guest user adds an item to the basket
**When** they later log in
**Then** their basket should be merged with any existing saved basket

**Edge cases:**
- Out-of-stock items: "Add to Basket" button should be disabled
- Items with variants (size/colour) must require variant selection before adding
- Basket persists for 7 days for guest users, indefinitely for logged-in users`,
    status: { name: 'To Do' },
    priority: { name: 'High' },
    assignee: { displayName: 'Bob Jones' },
    labels: ['basket', 'ecommerce'],
    components: [{ name: 'basket-service' }],
    epic: { key: 'DEMO-11', summary: 'Shopping Basket Epic' },
    created: '2026-04-05T10:00:00Z',
    updated: '2026-05-12T09:15:00Z',
  },
  'DEMO-3': {
    key: 'DEMO-3',
    summary: 'Apply Discount Code at Checkout',
    description: `## Acceptance Criteria

**Given** a user is on the checkout page
**When** they enter a valid discount code
**Then** the discount should be applied, shown as a line item, and the total recalculated

**Given** a user enters an expired discount code
**When** they click "Apply"
**Then** they should see "This code has expired" and no discount should be applied

**Given** a user enters a code that requires a minimum spend of £50
**When** their basket total is £45
**Then** they should see "Spend £5 more to use this code"

**Given** a user has already applied a discount code
**When** they attempt to apply a second code
**Then** they should see "Only one discount code can be applied per order"

**Business rules:**
- Codes are case-insensitive
- Codes cannot be applied to sale items unless explicitly flagged
- Discount is applied before delivery charges`,
    status: { name: 'To Do' },
    priority: { name: 'Medium' },
    assignee: null,
    labels: ['checkout', 'discount', 'ecommerce'],
    components: [{ name: 'checkout-service' }, { name: 'promotions-service' }],
    epic: { key: 'DEMO-11', summary: 'Shopping Basket Epic' },
    created: '2026-04-10T11:00:00Z',
    updated: '2026-05-14T16:00:00Z',
  },
  'DEMO-4': {
    key: 'DEMO-4',
    summary: 'Password Reset via Email',
    description: `## Acceptance Criteria

**Given** a user clicks "Forgot password" and enters their registered email
**When** they submit the form
**Then** they should receive a password reset email within 2 minutes
**And** see "If this email is registered, you will receive reset instructions"

**Given** a user clicks the reset link in the email
**When** the link is less than 1 hour old
**Then** they should be taken to a page to set a new password

**Given** a user clicks an expired reset link (>1 hour old)
**When** they try to use it
**Then** they should see "This link has expired. Request a new one."

**Given** a user sets a new password
**When** they submit it
**Then** the new password must: be at least 8 characters, contain uppercase, lowercase, and a number

**Security:**
- Reset tokens must be single-use
- All existing sessions must be invalidated on password reset
- Do not confirm whether an email is registered (prevent user enumeration)`,
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    assignee: { displayName: 'Alice Smith' },
    labels: ['authentication', 'security', 'email'],
    components: [{ name: 'auth-service' }, { name: 'email-service' }],
    epic: { key: 'DEMO-10', summary: 'Authentication Epic' },
    created: '2026-04-12T08:00:00Z',
    updated: '2026-05-15T11:00:00Z',
  },
  'DEMO-10': {
    key: 'DEMO-10',
    summary: 'Authentication Epic',
    description: 'Epic covering all user authentication and session management features.',
    status: { name: 'In Progress' },
    isEpic: true,
    children: ['DEMO-1', 'DEMO-4'],
  },
  'DEMO-11': {
    key: 'DEMO-11',
    summary: 'Shopping Basket Epic',
    description: 'Epic covering basket management, discount codes, and checkout flow.',
    status: { name: 'In Progress' },
    isEpic: true,
    children: ['DEMO-2', 'DEMO-3'],
  },
};

const MOCK_JQL_RESULTS: Record<string, string[]> = {
  'project = DEMO': ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4'],
  'project = DEMO AND issuetype = Epic': ['DEMO-10', 'DEMO-11'],
  authentication: ['DEMO-1', 'DEMO-4'],
  basket: ['DEMO-2', 'DEMO-3'],
  login: ['DEMO-1'],
};

function searchIssues(jql: string): object[] {
  const lower = jql.toLowerCase();
  for (const [key, issueKeys] of Object.entries(MOCK_JQL_RESULTS)) {
    if (lower.includes(key.toLowerCase())) {
      return issueKeys
        .map((k) => MOCK_ISSUES[k])
        .filter(Boolean);
    }
  }
  return Object.values(MOCK_ISSUES).slice(0, 4);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mock-jira-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// In-memory comment store for mock
const MOCK_COMMENTS: Record<string, Array<{id:string; author:string; body:string; created:string}>> = {};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'jira_get_issue',
      description: 'Get a Jira issue by key including acceptance criteria and metadata',
      inputSchema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Jira issue key e.g. DEMO-1' },
        },
        required: ['issue_key'],
      },
    },
    {
      name: 'jira_search',
      description: 'Search Jira issues using JQL',
      inputSchema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query string' },
          max_results: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['jql'],
      },
    },
    {
      name: 'jira_get_epic',
      description: 'Get an epic and its linked child stories',
      inputSchema: {
        type: 'object',
        properties: {
          epic_key: { type: 'string', description: 'Epic issue key e.g. DEMO-10' },
        },
        required: ['epic_key'],
      },
    },
    {
      name: 'jira_add_comment',
      description: 'Add a comment to a Jira issue',
      inputSchema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Jira issue key e.g. DEMO-1' },
          comment: { type: 'string', description: 'Comment body text (markdown supported)' },
        },
        required: ['issue_key', 'comment'],
      },
    },
    {
      name: 'jira_get_comments',
      description: 'Get comments on a Jira issue',
      inputSchema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Jira issue key' },
        },
        required: ['issue_key'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Simulate realistic API latency
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

  if (name === 'jira_get_issue') {
    const key = (args?.issue_key as string)?.toUpperCase();
    const issue = MOCK_ISSUES[key];
    if (!issue) {
      return {
        content: [{ type: 'text', text: `Issue ${key} not found. Available: ${Object.keys(MOCK_ISSUES).join(', ')}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
  }

  if (name === 'jira_search') {
    const jql = args?.jql as string ?? '';
    const results = searchIssues(jql);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }

  if (name === 'jira_get_epic') {
    const key = (args?.epic_key as string)?.toUpperCase();
    const epic = MOCK_ISSUES[key];
    if (!epic) {
      return { content: [{ type: 'text', text: `Epic ${key} not found` }], isError: true };
    }
    const epicData = epic as { children?: string[] };
    const children = (epicData.children ?? []).map((k: string) => MOCK_ISSUES[k]).filter(Boolean);
    return { content: [{ type: 'text', text: JSON.stringify({ epic, children }, null, 2) }] };
  }

  if (name === 'jira_add_comment') {
    const key = (args?.issue_key as string)?.toUpperCase();
    if (!MOCK_ISSUES[key]) {
      return { content: [{ type: 'text', text: `Issue ${key} not found` }], isError: true };
    }
    if (!MOCK_COMMENTS[key]) MOCK_COMMENTS[key] = [];
    const comment = {
      id: `comment-${Date.now()}`,
      author: 'QA Test Agent',
      body: args?.comment as string ?? '',
      created: new Date().toISOString(),
    };
    MOCK_COMMENTS[key].push(comment);
    process.stderr.write(`[mock-jira] Added comment to ${key}: ${comment.body.slice(0, 80)}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ commentId: comment.id, issueKey: key, added: true }, null, 2) }] };
  }

  if (name === 'jira_get_comments') {
    const key = (args?.issue_key as string)?.toUpperCase();
    const comments = MOCK_COMMENTS[key] ?? [];
    return { content: [{ type: 'text', text: JSON.stringify(comments, null, 2) }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mock-jira] Server started\n');
}

main().catch((e) => { process.stderr.write(`[mock-jira] Error: ${e}\n`); process.exit(1); });
