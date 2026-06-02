/**
 * src/local-kb/seed.ts
 *
 * Seed the local vector KB with sample data from all three mock servers.
 * Run once before the demo:
 *
 *   npx tsx src/local-kb/seed.ts
 *   npm run kb:local:seed
 */

import 'dotenv/config';
import { LocalKnowledgeBase } from './local-vector-db.js';
import { formatJiraDocument, formatConfluenceDocument, formatZephyrDocument, formatTestCaseDocument } from '../knowledge-base/formatters.js';
import { logger } from '../logger.js';

const db = new LocalKnowledgeBase('./local-kb-data');

async function seed() {
  logger.info('Seeding local Knowledge Base...\n');
  await db.clear();

  // ── Jira Acceptance Criteria ─────────────────────────────────────────────
  logger.info('Ingesting Jira issues...');

  await db.addDocuments([
    formatJiraDocument({
      key: 'DEMO-1',
      summary: 'User Login with Email and Password',
      description: `Given a user is on the login page
When they enter a valid registered email and correct password
Then they should be redirected to the dashboard

Given a user enters an incorrect password
When they submit the login form
Then they should see "Invalid email or password"

Given a user fails to login 5 consecutive times
When they attempt a 6th login
Then their account should be locked for 15 minutes

Given a user checks "Remember me"
When they close and reopen the browser
Then they should still be logged in (30 day token)

Non-functional: Login response time < 500ms at p95. Passwords hashed with bcrypt (12 rounds).`,
      components: [{ name: 'auth-service' }],
      epic: { key: 'DEMO-10', summary: 'Authentication Epic' },
    }),

    formatJiraDocument({
      key: 'DEMO-2',
      summary: 'Add Item to Shopping Basket',
      description: `Given a logged-in user is on a product page
When they click "Add to Basket"
Then the item should appear with quantity 1 and a success toast

Given an item is already in the basket
When the user adds the same item again
Then the quantity should increment (not duplicate)

Given a product has limited stock (3 remaining)
When the user tries to add a 4th unit
Then they should see "Only 3 left in stock"

Given a guest user adds an item and then logs in
Then their basket should be merged with saved basket

Edge: Out-of-stock items button disabled; variants require selection first`,
      components: [{ name: 'basket-service' }],
      epic: { key: 'DEMO-11', summary: 'Shopping Basket Epic' },
    }),

    formatJiraDocument({
      key: 'DEMO-3',
      summary: 'Apply Discount Code at Checkout',
      description: `Given a user enters a valid discount code
Then the discount is applied and total recalculated

Given a user enters an expired code
Then they see "This code has expired"

Given a code requires £50 minimum and basket is £45
Then they see "Spend £5 more to use this code"

Given a code is already applied and user tries another
Then they see "Only one discount code can be applied per order"

Business rules: codes case-insensitive; cannot apply to sale items unless flagged; before delivery charges`,
      components: [{ name: 'checkout-service' }],
      epic: { key: 'DEMO-11', summary: 'Shopping Basket Epic' },
    }),

    formatJiraDocument({
      key: 'DEMO-4',
      summary: 'Password Reset via Email',
      description: `Given a user clicks "Forgot password" and enters their email
Then they receive a reset email within 2 minutes
And see "If this email is registered, you will receive reset instructions"

Given a user clicks the reset link (< 1 hour old)
Then they can set a new password

Given a user clicks an expired link (> 1 hour)
Then they see "This link has expired. Request a new one."

New password rules: min 8 chars, uppercase, lowercase, number required

Security: tokens single-use; all sessions invalidated on reset; no email enumeration`,
      components: [{ name: 'auth-service' }],
      epic: { key: 'DEMO-10', summary: 'Authentication Epic' },
    }),
  ]);

  // ── Confluence Pages ─────────────────────────────────────────────────────
  logger.info('Ingesting Confluence pages...');

  await db.addDocuments([
    formatConfluenceDocument({
      id: 'page-auth-architecture',
      title: 'Authentication Service — Architecture',
      body: `Technology: Node.js 22, Fastify, PostgreSQL, Redis, bcrypt (12 rounds), AWS SES.
Key endpoints: POST /auth/login, /auth/logout, /auth/refresh, /auth/password/reset/request, /auth/password/reset/confirm.
Sessions: JWT access tokens (15 min), refresh tokens (30 days Redis), remember-me tokens (30 days PostgreSQL).
Security: 5 failed logins → 15 min lockout per IP and per account. Reset tokens: single-use SHA-256 hash, 1hr TTL.
Performance: p95 login < 500ms, p99 < 1000ms, session lookup < 10ms (Redis).
All auth errors return HTTP 401 with generic message (no user enumeration).`,
      space: 'PLATFORM',
    }),

    formatConfluenceDocument({
      id: 'page-basket-architecture',
      title: 'Basket & Checkout Service — Architecture',
      body: `Technology: Python 3.12, FastAPI, Redis (basket store), PostgreSQL (orders), promotions-service (gRPC), inventory-service (gRPC).
Basket TTL: 7 days for guests, indefinite for authenticated users.
Key endpoints: GET/POST /basket, POST /basket/items, POST /basket/discount, POST /checkout/complete.
Basket merge on login: identical items sum quantities; guest basket wins on conflict; guest basket deleted after merge.
Promotions: gRPC call to promotions-service. Max one code per basket. Case-normalised before validation.
Stock: soft reservation on checkout (15 min hold); hard confirm on payment. Pessimistic lock on last item.`,
      space: 'PLATFORM',
    }),
  ]);

  // ── Existing Zephyr Test Cases ────────────────────────────────────────────
  logger.info('Ingesting Zephyr test cases...');

  await db.addDocuments([
    formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Successful login with valid credentials',
      objective: 'Verify user can log in with correct email and password.',
      precondition: 'User exists with email test@demo.com, password Test1234!',
      linkedIssues: ['DEMO-1'],
      steps: [
        { description: 'Navigate to /login', expectedResult: 'Login page displayed' },
        { description: 'Enter valid email and password', expectedResult: 'Fields populated' },
        { description: 'Click Sign In', expectedResult: 'Redirected to /dashboard' },
      ],
    }),

    formatZephyrDocument({
      key: 'DEMO-T2',
      name: 'Login fails with incorrect password',
      objective: 'Verify correct error on wrong password.',
      linkedIssues: ['DEMO-1'],
      steps: [
        { description: 'Enter valid email + wrong password', expectedResult: 'Fields populated' },
        { description: 'Click Sign In', expectedResult: 'Error "Invalid email or password"; user stays on /login' },
      ],
    }),

    formatZephyrDocument({
      key: 'DEMO-T3',
      name: 'Account lockout after 5 failed login attempts',
      objective: 'Verify lockout after 5 consecutive failures.',
      priority: { name: 'Critical' },
      linkedIssues: ['DEMO-1'],
      steps: [
        { description: 'Attempt login with wrong password 5 times', expectedResult: 'Each shows "Invalid email or password"' },
        { description: 'Attempt 6th login', expectedResult: 'Account locked message; lockout lasts 15 minutes' },
        { description: 'Wait 15 min and try valid credentials', expectedResult: 'Login succeeds' },
      ],
    }),

    formatZephyrDocument({
      key: 'DEMO-T4',
      name: 'Add single item to empty basket',
      objective: 'Verify item added correctly with success message.',
      precondition: 'User logged in; basket empty; PROD-001 in stock.',
      linkedIssues: ['DEMO-2'],
      steps: [
        { description: 'Navigate to product page', expectedResult: 'Add to Basket button enabled' },
        { description: 'Click Add to Basket', expectedResult: 'Success toast; basket count = 1' },
        { description: 'Navigate to /basket', expectedResult: 'PROD-001 shown, quantity 1, correct price' },
      ],
    }),

    formatZephyrDocument({
      key: 'DEMO-T5',
      name: 'Quantity increments when adding duplicate item',
      objective: 'Adding existing item increments qty instead of duplicating.',
      precondition: 'Basket has PROD-001 with quantity 1.',
      linkedIssues: ['DEMO-2'],
      steps: [
        { description: 'Add PROD-001 again', expectedResult: 'Basket shows quantity 2 (not two lines)' },
      ],
    }),
  ]);

  // ── Previously Generated Test Cases ──────────────────────────────────────
  logger.info('Ingesting previously generated test cases...');

  await db.addDocuments([
    formatTestCaseDocument(`
## Test Case: DEMO-T6 — Login with SQL injection in email field

**Type:** Security  **Priority:** Critical

### Preconditions
- Login page accessible

### Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Enter \`' OR 1=1 --\` in email field | Field accepts input |
| 2 | Enter any value in password | Field populated |
| 3 | Submit form | Returns "Invalid email or password"; no DB error exposed |

### Expected Outcome
Authentication fails gracefully. No SQL error in response. Injection has no effect.
    `.trim(), {
      jiraIssueKey: 'DEMO-1',
      featureArea: 'authentication',
      component: 'auth-service',
      approvedBy: 'alice.smith',
      projectKey: 'DEMO',
    }),
  ]);

  const count = await db.count();
  logger.info(`\n✓ Local KB seeded with ${count} documents`);
  logger.info(`  Location: ${db.getStats().dataDir}`);
  logger.info('\nRun the demo:');
  logger.info('  npm run demo\n');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
