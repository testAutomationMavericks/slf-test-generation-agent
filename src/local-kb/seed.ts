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
    formatJiraDocument('DEMO-1', 'User Login with Email and Password', `
Given a user is on the login page
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

Non-functional: Login response time < 500ms at p95. Passwords hashed with bcrypt (12 rounds).
    `.trim(), { projectKey: 'DEMO', epic: 'DEMO-10', component: 'auth-service' }),

    formatJiraDocument('DEMO-2', 'Add Item to Shopping Basket', `
Given a logged-in user is on a product page
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

Edge: Out-of-stock items button disabled; variants require selection first
    `.trim(), { projectKey: 'DEMO', epic: 'DEMO-11', component: 'basket-service' }),

    formatJiraDocument('DEMO-3', 'Apply Discount Code at Checkout', `
Given a user enters a valid discount code
Then the discount is applied and total recalculated

Given a user enters an expired code
Then they see "This code has expired"

Given a code requires £50 minimum and basket is £45
Then they see "Spend £5 more to use this code"

Given a code is already applied and user tries another
Then they see "Only one discount code can be applied per order"

Business rules: codes case-insensitive; cannot apply to sale items unless flagged; before delivery charges
    `.trim(), { projectKey: 'DEMO', epic: 'DEMO-11', component: 'checkout-service' }),

    formatJiraDocument('DEMO-4', 'Password Reset via Email', `
Given a user clicks "Forgot password" and enters their email
Then they receive a reset email within 2 minutes
And see "If this email is registered, you will receive reset instructions"

Given a user clicks the reset link (< 1 hour old)
Then they can set a new password

Given a user clicks an expired link (> 1 hour)
Then they see "This link has expired. Request a new one."

New password rules: min 8 chars, uppercase, lowercase, number required

Security: tokens single-use; all sessions invalidated on reset; no email enumeration
    `.trim(), { projectKey: 'DEMO', epic: 'DEMO-10', component: 'auth-service' }),
  ]);

  // ── Confluence Pages ─────────────────────────────────────────────────────
  logger.info('Ingesting Confluence pages...');

  await db.addDocuments([
    formatConfluenceDocument(
      'page-auth-architecture',
      'Authentication Service — Architecture',
      `Technology: Node.js 22, Fastify, PostgreSQL, Redis, bcrypt (12 rounds), AWS SES.
Key endpoints: POST /auth/login, /auth/logout, /auth/refresh, /auth/password/reset/request, /auth/password/reset/confirm.
Sessions: JWT access tokens (15 min), refresh tokens (30 days Redis), remember-me tokens (30 days PostgreSQL).
Security: 5 failed logins → 15 min lockout per IP and per account. Reset tokens: single-use SHA-256 hash, 1hr TTL.
Performance: p95 login < 500ms, p99 < 1000ms, session lookup < 10ms (Redis).
All auth errors return HTTP 401 with generic message (no user enumeration).`,
      { spaceKey: 'PLATFORM', pageType: 'architecture' }
    ),

    formatConfluenceDocument(
      'page-basket-architecture',
      'Basket & Checkout Service — Architecture',
      `Technology: Python 3.12, FastAPI, Redis (basket store), PostgreSQL (orders), promotions-service (gRPC), inventory-service (gRPC).
Basket TTL: 7 days for guests, indefinite for authenticated users.
Key endpoints: GET/POST /basket, POST /basket/items, POST /basket/discount, POST /checkout/complete.
Basket merge on login: identical items sum quantities; guest basket wins on conflict; guest basket deleted after merge.
Promotions: gRPC call to promotions-service. Max one code per basket. Case-normalised before validation.
Stock: soft reservation on checkout (15 min hold); hard confirm on payment. Pessimistic lock on last item.`,
      { spaceKey: 'PLATFORM', pageType: 'architecture' }
    ),
  ]);

  // ── Existing Zephyr Test Cases ────────────────────────────────────────────
  logger.info('Ingesting Zephyr test cases...');

  await db.addDocuments([
    formatZephyrDocument(
      'DEMO-T1', 'Successful login with valid credentials',
      `Objective: Verify user can log in with correct email and password.
Precondition: User exists with email test@demo.com, password Test1234!
Steps:
1. Navigate to /login → Login page displayed
2. Enter valid email and password → Fields populated
3. Click Sign In → Redirected to /dashboard`,
      { projectKey: 'DEMO', linkedIssue: 'DEMO-1', folder: 'Authentication/Login' }
    ),

    formatZephyrDocument(
      'DEMO-T2', 'Login fails with incorrect password',
      `Objective: Verify correct error on wrong password.
Steps:
1. Enter valid email + wrong password → Fields populated
2. Click Sign In → Error "Invalid email or password"; user stays on /login`,
      { projectKey: 'DEMO', linkedIssue: 'DEMO-1', folder: 'Authentication/Login' }
    ),

    formatZephyrDocument(
      'DEMO-T3', 'Account lockout after 5 failed login attempts',
      `Objective: Verify lockout after 5 consecutive failures.
Priority: Critical
Steps:
1. Attempt login with wrong password 5 times → each shows "Invalid email or password"
2. Attempt 6th login → account locked message; lockout lasts 15 minutes
3. Wait 15 min and try valid credentials → login succeeds`,
      { projectKey: 'DEMO', linkedIssue: 'DEMO-1', folder: 'Authentication/Security' }
    ),

    formatZephyrDocument(
      'DEMO-T4', 'Add single item to empty basket',
      `Objective: Verify item added correctly with success message.
Precondition: User logged in; basket empty; PROD-001 in stock.
Steps:
1. Navigate to product page → Add to Basket button enabled
2. Click Add to Basket → Success toast; basket count = 1
3. Navigate to /basket → PROD-001 shown, quantity 1, correct price`,
      { projectKey: 'DEMO', linkedIssue: 'DEMO-2', folder: 'Basket/Add Item' }
    ),

    formatZephyrDocument(
      'DEMO-T5', 'Quantity increments when adding duplicate item',
      `Objective: Adding existing item increments qty instead of duplicating.
Precondition: Basket has PROD-001 with quantity 1.
Steps:
1. Add PROD-001 again → Basket shows quantity 2 (not two lines)`,
      { projectKey: 'DEMO', linkedIssue: 'DEMO-2', folder: 'Basket/Add Item' }
    ),
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
      jiraEpic: 'DEMO-10',
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
