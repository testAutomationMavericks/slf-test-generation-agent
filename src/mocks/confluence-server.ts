/**
 * src/mocks/confluence-server.ts
 *
 * Mock MCP server that behaves like mcp-atlassian (Confluence).
 * Contains realistic architecture and scope documentation pages.
 *
 * Swap to real server by pointing .mcp.json at the real mcp-atlassian.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Sample Pages ─────────────────────────────────────────────────────────────

const MOCK_PAGES: Record<string, object> = {
  'page-auth-architecture': {
    id: 'page-auth-architecture',
    title: 'Authentication Service — Architecture',
    space: { key: 'PLATFORM', name: 'Platform Engineering' },
    content: `# Authentication Service Architecture

## Overview
The authentication service handles all user identity, session management, and access control.
It is a standalone Node.js microservice exposing REST and gRPC interfaces.

## Technology Stack
- **Runtime:** Node.js 22 LTS
- **Framework:** Fastify 4
- **Database:** PostgreSQL 16 (users, sessions, tokens)
- **Cache:** Redis 7 (session tokens, rate limiting)
- **Email:** AWS SES via email-service microservice
- **Password hashing:** bcrypt (12 rounds)

## Key Endpoints
| Endpoint | Method | Description |
|---|---|---|
| /auth/login | POST | Authenticate with email + password |
| /auth/logout | POST | Invalidate current session |
| /auth/refresh | POST | Refresh access token using refresh token |
| /auth/password/reset/request | POST | Initiate password reset flow |
| /auth/password/reset/confirm | POST | Complete password reset with token |
| /auth/password/change | POST | Change password (authenticated) |

## Session Management
- Access tokens: JWT, 15 minute expiry
- Refresh tokens: opaque UUID stored in Redis, 30 day expiry
- Remember-me tokens: stored in PostgreSQL, 30 day expiry
- All tokens invalidated on password change/reset

## Security Considerations
- Rate limiting: 5 failed logins per 15 min window per IP + per account
- Account lockout after 5 consecutive failures (15 min lockout)
- PBKDF2 key stretching on all bcrypt operations
- Reset tokens: single-use, 1 hour TTL, stored as SHA-256 hash
- Never confirm email registration status in public-facing responses

## Error Handling
All authentication errors return HTTP 401 with generic message to prevent user enumeration.
Internal error codes are logged but not exposed in API responses.

## Performance Targets
- p95 login latency: < 500ms
- p99 login latency: < 1000ms
- Session lookup: < 10ms (Redis)`,
    created: '2026-01-15T10:00:00Z',
    updated: '2026-05-01T09:00:00Z',
    author: 'Alice Smith',
    relatedIssues: ['DEMO-1', 'DEMO-4'],
  },

  'page-basket-architecture': {
    id: 'page-basket-architecture',
    title: 'Basket & Checkout Service — Architecture',
    space: { key: 'PLATFORM', name: 'Platform Engineering' },
    content: `# Basket & Checkout Service Architecture

## Overview
The basket service manages user shopping baskets, promotions, and the checkout pipeline.
It is a Python/FastAPI service backed by a Redis basket store and PostgreSQL for orders.

## Technology Stack
- **Runtime:** Python 3.12
- **Framework:** FastAPI
- **Basket store:** Redis (TTL: 7 days guest, no expiry for authenticated users)
- **Order store:** PostgreSQL
- **Promotions engine:** Standalone promotions-service (gRPC)
- **Inventory:** inventory-service (gRPC, read-only)

## Key Endpoints
| Endpoint | Method | Description |
|---|---|---|
| /basket | GET | Retrieve current basket |
| /basket/items | POST | Add item to basket |
| /basket/items/{id} | PUT | Update item quantity |
| /basket/items/{id} | DELETE | Remove item |
| /basket/discount | POST | Apply discount code |
| /basket/discount | DELETE | Remove discount code |
| /checkout/validate | POST | Validate basket before payment |
| /checkout/complete | POST | Complete order (post-payment) |

## Basket Merging
When a guest logs in, their anonymous basket is merged with any existing saved basket:
1. Identical items: quantities are summed (capped at stock level)
2. Conflicting variants: guest basket takes precedence
3. Guest basket is deleted after merge

## Promotions Engine Integration
- Discount codes validated synchronously via gRPC call to promotions-service
- Promotions-service returns: valid/invalid, discount amount, error reason
- Codes are case-normalised (lowercase) before validation
- Maximum one discount code per basket at any time

## Stock Validation
- Stock level checked via inventory-service on every add-to-basket
- Soft reservation on checkout (held for 15 mins)
- Hard confirmation on payment success

## Edge Cases Handled
- Race condition on last item: pessimistic locking in inventory-service
- Basket restore on payment failure: basket re-opened from snapshot
- Price changes between add and checkout: checkout/validate re-prices all items`,
    created: '2026-02-01T11:00:00Z',
    updated: '2026-05-08T14:00:00Z',
    author: 'Bob Jones',
    relatedIssues: ['DEMO-2', 'DEMO-3'],
  },

  'page-testing-standards': {
    id: 'page-testing-standards',
    title: 'QA Testing Standards & Guidelines',
    space: { key: 'QUALITY', name: 'Quality Assurance' },
    content: `# QA Testing Standards & Guidelines

## Test Case Structure
All test cases must follow the Given/When/Then format for clarity.
Each test case must include: objective, preconditions, step-by-step actions, expected results.

## Priority Classification
- **Critical:** Core user journeys, payment flows, authentication
- **High:** Key features, data integrity, security
- **Medium:** Secondary features, edge cases
- **Low:** Nice-to-have, cosmetic issues

## Test Coverage Requirements
- Critical paths: 100% coverage required before release
- High priority: 90% coverage required
- Medium: 70% coverage required
- All acceptance criteria must have at least one corresponding test case

## Test Types Required Per Story
1. **Happy path** — primary success scenario
2. **Alternative paths** — secondary valid flows
3. **Negative tests** — invalid inputs, error states
4. **Boundary tests** — limits, thresholds, edge values
5. **Security tests** — for auth/payment features

## Environments
- **Dev:** Unit + integration tests run on every PR
- **Staging:** Full regression suite nightly
- **Production:** Smoke tests post-deploy`,
    created: '2026-01-01T09:00:00Z',
    updated: '2026-03-15T10:00:00Z',
    author: 'QA Team',
    relatedIssues: [],
  },
};

const SEARCH_INDEX: Record<string, string[]> = {
  auth: ['page-auth-architecture'],
  login: ['page-auth-architecture'],
  password: ['page-auth-architecture'],
  basket: ['page-basket-architecture'],
  checkout: ['page-basket-architecture'],
  discount: ['page-basket-architecture'],
  testing: ['page-testing-standards'],
  standards: ['page-testing-standards'],
  platform: ['page-auth-architecture', 'page-basket-architecture'],
};

function searchPages(query: string): object[] {
  const lower = query.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, pageIds] of Object.entries(SEARCH_INDEX)) {
    if (lower.includes(keyword)) pageIds.forEach((id) => found.add(id));
  }
  if (found.size === 0) return Object.values(MOCK_PAGES).slice(0, 2);
  return Array.from(found).map((id) => MOCK_PAGES[id]).filter(Boolean);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mock-confluence-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'confluence_get_page',
      description: 'Get a Confluence page by ID',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID' },
        },
        required: ['page_id'],
      },
    },
    {
      name: 'confluence_search',
      description: 'Search Confluence pages by keyword',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          space_key: { type: 'string', description: 'Limit to a space (optional)' },
          max_results: { type: 'number' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));

  if (name === 'confluence_get_page') {
    const id = args?.page_id as string;
    const page = MOCK_PAGES[id];
    if (!page) {
      return {
        content: [{ type: 'text', text: `Page ${id} not found. Available: ${Object.keys(MOCK_PAGES).join(', ')}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }] };
  }

  if (name === 'confluence_search') {
    const query = args?.query as string ?? '';
    const results = searchPages(query);
    // Return page summaries (without full content for search)
    const summaries = results.map((p: any) => ({
      id: p.id,
      title: p.title,
      space: p.space,
      excerpt: (p.content as string).slice(0, 200) + '...',
      updated: p.updated,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mock-confluence] Server started\n');
}

main().catch((e) => { process.stderr.write(`[mock-confluence] Error: ${e}\n`); process.exit(1); });
