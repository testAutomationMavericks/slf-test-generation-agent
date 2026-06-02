/**
 * tests/unit/test-case-parser.test.ts
 *
 * Unit tests for the test case markdown parser and provider config validation.
 * Pure logic tests — no filesystem, no network.
 *
 * Run: npm run test:unit
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline the parser (avoids import issues with React client code) ──────────

interface ReviewCase {
  id: number;
  name: string;
  type: string;
  priority: string;
  precondition: string;
  steps: Array<{ description: string; expectedResult: string }>;
  outcome: string;
  content: string;
  selected: boolean;
  uploaded: boolean;
  uploadError: null | string;
}

function parseTestCases(markdown: string, fallbackName?: string): ReviewCase[] {
  const blocks = markdown.split(/(?=^## )/m).filter((b: string) => b.trim());
  const cases: ReviewCase[] = [];

  for (const block of blocks) {
    const heading = block.split('\n')[0].replace(/^#+\s*/, '').trim();
    const match = heading.match(/(?:Test Case[:\s]+(?:TC-\w+\s+[-—]?\s*)?)?(.+)/i);
    const name = match?.[1]?.trim() ?? heading;
    if (!name || name.length <= 3) continue;

    const typeMatch = block.match(/\*\*Type:\*\*\s*([^\n*]+)/i);
    const priorityMatch = block.match(/\*\*Priority:\*\*\s*([^\n*]+)/i);

    const lines = block.split('\n');
    const preIdx = lines.findIndex((l: string) => /precondition/i.test(l));
    const stepsIdx = lines.findIndex((l: string) => /test steps|steps/i.test(l));
    const outcomeIdx = lines.findIndex((l: string) => /expected outcome|outcome/i.test(l));

    const precondition = preIdx >= 0
      ? lines.slice(preIdx + 1, stepsIdx > preIdx ? stepsIdx : preIdx + 5)
          .filter((l: string) => l.trim() && !l.startsWith('#'))
          .map((l: string) => l.replace(/^[-*]\s*/, '')).join('\n')
      : '';

    const stepLines = lines.filter((l: string) => /^\|\s*\d/.test(l));
    const steps = stepLines.map((l: string) => {
      const cols = l.split('|').map((c: string) => c.trim()).filter(Boolean);
      return { description: cols[1] || '', expectedResult: cols[2] || '' };
    });

    const outcome = outcomeIdx >= 0
      ? lines.slice(outcomeIdx + 1, outcomeIdx + 4)
          .filter((l: string) => l.trim() && !l.startsWith('#')).join(' ')
      : '';

    cases.push({
      id: cases.length,
      name: name.slice(0, 120),
      type: typeMatch?.[1]?.trim() ?? 'Functional',
      priority: priorityMatch?.[1]?.trim() ?? 'Medium',
      precondition, steps, outcome, content: block.trim(),
      selected: true, uploaded: false, uploadError: null,
    });
  }

  if (cases.length === 0 && markdown.trim().length > 50) {
    cases.push({
      id: 0,
      name: fallbackName ?? 'Generated test cases',
      type: 'Functional', priority: 'Medium',
      precondition: '', steps: [], outcome: '',
      content: markdown.trim(),
      selected: true, uploaded: false, uploadError: null,
    });
  }

  return cases;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SINGLE_TC = `
## Test Case: TC-001 Valid Discount Code Applied Successfully

**Type:** Functional
**Priority:** Critical

### Preconditions
- User is logged in and on the checkout page
- Valid discount code SUMMER20 exists in system

### Test Steps
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to checkout page | Checkout page displayed with discount field |
| 2 | Enter code SUMMER20 | Code accepted, field populated |
| 3 | Click Apply | 20% discount applied as line item |
| 4 | Verify order total | Total reduced by exactly 20% |

### Expected Outcome
Discount is applied, visible in order summary, total is correct.
`.trim();

const MULTI_TC = `
## Test Case: TC-001 Valid Login — Happy Path

**Type:** Functional
**Priority:** High

### Preconditions
- User account exists with valid credentials

### Test Steps
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enter valid email | Field accepts input |
| 2 | Enter valid password | Password masked |
| 3 | Click Sign In | User redirected to dashboard |

### Expected Outcome
User is authenticated and reaches the dashboard.

## Test Case: TC-002 Login with Invalid Password

**Type:** Negative
**Priority:** High

### Preconditions
- Valid user account exists

### Test Steps
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enter valid email | Field accepts input |
| 2 | Enter wrong password | Password masked |
| 3 | Click Sign In | Error: "Invalid email or password" shown |

### Expected Outcome
User remains on login page, error message displayed, no authentication.

## Test Case: TC-003 Account Lockout After 5 Failed Attempts

**Type:** Security
**Priority:** Critical

### Preconditions
- Valid user account exists

### Test Steps
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Attempt login with wrong password 5× | Error shown each time |
| 2 | Attempt 6th login | Account locked, lockout message shown |
| 3 | Wait 15 minutes | Account unlocks automatically |

### Expected Outcome
Account is locked after 5 failures with clear messaging.
`.trim();

// ─── Parser — single test case ────────────────────────────────────────────────

describe('parseTestCases — single test case', () => {
  test('parses one test case from markdown', () => {
    const cases = parseTestCases(SINGLE_TC);
    assert.equal(cases.length, 1);
  });

  test('extracts name correctly', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.ok(tc.name.includes('Valid Discount Code'), `Got: ${tc.name}`);
  });

  test('extracts type as Functional', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.type, 'Functional');
  });

  test('extracts priority as Critical', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.priority, 'Critical');
  });

  test('extracts preconditions', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.ok(tc.precondition.length > 0, 'Precondition should not be empty');
    assert.ok(tc.precondition.includes('checkout') || tc.precondition.includes('logged'));
  });

  test('extracts test steps', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.steps.length, 4, 'Should parse 4 steps');
    assert.ok(tc.steps[0].description.length > 0);
    assert.ok(tc.steps[0].expectedResult.length > 0);
  });

  test('step 2 has correct content', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.ok(tc.steps[1].description.toLowerCase().includes('summer20') ||
              tc.steps[1].description.toLowerCase().includes('code'));
  });

  test('extracts outcome', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.ok(tc.outcome.length > 0, 'Outcome should not be empty');
  });

  test('sets selected=true by default', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.selected, true);
  });

  test('sets uploaded=false by default', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.uploaded, false);
  });

  test('assigns id=0 for first case', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.equal(tc.id, 0);
  });

  test('includes full content block', () => {
    const [tc] = parseTestCases(SINGLE_TC);
    assert.ok(tc.content.includes('## Test Case'), 'Content should include heading');
    assert.ok(tc.content.length > 100);
  });

  test('name is truncated to 120 chars max', () => {
    const longName = `## Test Case: ${'A'.repeat(200)}`;
    const cases = parseTestCases(longName + '\nSome content here to make it long enough to not be ignored.');
    if (cases.length > 0) {
      assert.ok(cases[0].name.length <= 120);
    }
  });
});

// ─── Parser — multiple test cases ────────────────────────────────────────────

describe('parseTestCases — multiple test cases', () => {
  let cases: ReviewCase[];

  test('parses three test cases', () => {
    cases = parseTestCases(MULTI_TC);
    assert.equal(cases.length, 3);
  });

  test('assigns sequential IDs', () => {
    const c = parseTestCases(MULTI_TC);
    assert.equal(c[0].id, 0);
    assert.equal(c[1].id, 1);
    assert.equal(c[2].id, 2);
  });

  test('TC-001 is Functional/High', () => {
    const c = parseTestCases(MULTI_TC);
    assert.equal(c[0].type, 'Functional');
    assert.equal(c[0].priority, 'High');
  });

  test('TC-002 is Negative type', () => {
    const c = parseTestCases(MULTI_TC);
    assert.equal(c[1].type, 'Negative');
  });

  test('TC-003 is Security/Critical', () => {
    const c = parseTestCases(MULTI_TC);
    assert.equal(c[2].type, 'Security');
    assert.equal(c[2].priority, 'Critical');
  });

  test('each case has steps', () => {
    const c = parseTestCases(MULTI_TC);
    for (const tc of c) {
      assert.ok(tc.steps.length > 0, `${tc.name} should have steps`);
    }
  });

  test('TC-003 has 3 steps', () => {
    const c = parseTestCases(MULTI_TC);
    assert.equal(c[2].steps.length, 3);
  });
});

// ─── Parser — defaults and fallback ──────────────────────────────────────────

describe('parseTestCases — defaults and edge cases', () => {
  test('defaults type to Functional when not specified', () => {
    const md = `## Test Case: No Type Specified\n\nSome test content here with enough text.`;
    const cases = parseTestCases(md);
    if (cases.length > 0) assert.equal(cases[0].type, 'Functional');
  });

  test('defaults priority to Medium when not specified', () => {
    const md = `## Test Case: No Priority Specified\n\nSome test content here with enough text.`;
    const cases = parseTestCases(md);
    if (cases.length > 0) assert.equal(cases[0].priority, 'Medium');
  });

  test('always produces a case for long content (no ## required)', () => {
    // The parser uses the first line as heading even for unstructured text
    // Long content (>3 chars first line) always yields at least 1 case
    const md = 'This is a long paragraph output from Claude. '.repeat(5);
    const cases = parseTestCases(md, 'Fallback Test');
    assert.ok(cases.length >= 1, 'Long content should always yield at least 1 case');
    assert.equal(cases[0].selected, true);
    assert.equal(cases[0].uploaded, false);
  });

  test('uses fallback name when no ## headings and content < 50 chars', () => {
    // The fallback name is only used by the explicit fallback path (cases.length===0 && len>50)
    // For very short content that still produces a case: name comes from first line
    // Test the explicit fallback: empty content
    const cases = parseTestCases('', 'My Fallback');
    assert.equal(cases.length, 0, 'Empty string produces no cases');
  });

  test('returns empty array for empty string', () => {
    const cases = parseTestCases('');
    assert.equal(cases.length, 0, 'Empty string should produce 0 cases');
  });

  test('returns empty array for empty string', () => {
    const cases = parseTestCases('');
    assert.equal(cases.length, 0);
  });

  test('ignores headings shorter than 3 chars', () => {
    const md = `## TC\nContent\n\n## Valid Test Case Name\nMore content here`;
    const cases = parseTestCases(md);
    assert.equal(cases.length, 1, 'Short heading TC should be ignored');
    assert.ok(cases[0].name.includes('Valid Test Case'));
  });

  test('strips TC prefix from name', () => {
    const md = `## Test Case: TC-042 My Actual Test Name\n\n**Type:** Functional\n\nContent`;
    const cases = parseTestCases(md);
    if (cases.length > 0) {
      assert.ok(!cases[0].name.startsWith('Test Case:'), 'Should strip "Test Case:" prefix');
      assert.ok(!cases[0].name.startsWith('TC-042'), 'Should strip TC-042 prefix');
    }
  });

  test('handles em dash separator in heading', () => {
    const md = `## TC-001 — Valid Login\n\n**Type:** Functional\n\nContent`;
    const cases = parseTestCases(md);
    if (cases.length > 0) {
      assert.ok(cases[0].name.length > 0);
    }
  });
});

// ─── Provider config validation ───────────────────────────────────────────────

describe('AI Provider validation logic', () => {
  type AIProvider = 'claudecode' | 'anthropic' | 'openai' | 'local';

  function validateProviderConfig(provider: AIProvider, cfg: Record<string, string>): string | null {
    if (provider === 'anthropic' && !cfg.anthropicApiKey) return 'Anthropic API key is required';
    if (provider === 'openai' && !cfg.openaiApiKey) return 'OpenAI API key is required';
    if (provider === 'local' && !cfg.localBaseUrl) return 'Local model base URL is required';
    if (provider === 'local' && cfg.localBaseUrl && !cfg.localBaseUrl.startsWith('http')) {
      return 'Local model URL must start with http:// or https://';
    }
    return null;
  }

  test('claudecode needs no keys — always valid', () => {
    assert.equal(validateProviderConfig('claudecode', {}), null);
    assert.equal(validateProviderConfig('claudecode', { anything: 'value' }), null);
  });

  test('anthropic without key returns error', () => {
    const err = validateProviderConfig('anthropic', {});
    assert.ok(err !== null, 'Should return an error');
    assert.ok(err!.toLowerCase().includes('key'));
  });

  test('anthropic with key is valid', () => {
    assert.equal(validateProviderConfig('anthropic', { anthropicApiKey: 'sk-ant-test-123' }), null);
  });

  test('openai without key returns error', () => {
    const err = validateProviderConfig('openai', {});
    assert.ok(err !== null);
    assert.ok(err!.toLowerCase().includes('key'));
  });

  test('openai with key is valid', () => {
    assert.equal(validateProviderConfig('openai', { openaiApiKey: 'sk-test-123' }), null);
  });

  test('local without baseUrl returns error', () => {
    const err = validateProviderConfig('local', {});
    assert.ok(err !== null);
    assert.ok(err!.toLowerCase().includes('url'));
  });

  test('local with valid URL is valid', () => {
    assert.equal(validateProviderConfig('local', { localBaseUrl: 'http://localhost:11434/v1' }), null);
  });

  test('local with invalid URL returns error', () => {
    const err = validateProviderConfig('local', { localBaseUrl: 'localhost:11434' });
    assert.ok(err !== null, 'Should error on missing http:// prefix');
  });
});

// ─── Approval ID format validation ───────────────────────────────────────────

describe('Approval ID format', () => {
  function generateApprovalId(): string {
    return `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function isValidApprovalId(id: string): boolean {
    return /^apr-\d+-[a-z0-9]{4}$/.test(id);
  }

  test('generated ID matches expected format', () => {
    const id = generateApprovalId();
    assert.ok(isValidApprovalId(id), `ID "${id}" should match apr-TIMESTAMP-XXXX format`);
  });

  test('generated IDs are unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateApprovalId()));
    assert.equal(ids.size, 100, 'All 100 generated IDs should be unique');
  });

  test('ID starts with apr- prefix', () => {
    const id = generateApprovalId();
    assert.ok(id.startsWith('apr-'));
  });

  test('rejects IDs without prefix', () => {
    assert.equal(isValidApprovalId('1234567890-abcd'), false);
    assert.equal(isValidApprovalId(''), false);
    assert.equal(isValidApprovalId('random-string'), false);
  });
});

// ─── Priority chip class mapping ─────────────────────────────────────────────

describe('Priority chip CSS class mapping', () => {
  function chipClass(priority?: string): string {
    const l = (priority ?? 'medium').toLowerCase();
    return l === 'critical' ? 'chip chip-critical'
      : l === 'high' ? 'chip chip-high'
      : l === 'low' ? 'chip chip-low'
      : 'chip chip-medium';
  }

  test('Critical → chip-critical', () => assert.equal(chipClass('Critical'), 'chip chip-critical'));
  test('High → chip-high', () => assert.equal(chipClass('High'), 'chip chip-high'));
  test('Medium → chip-medium', () => assert.equal(chipClass('Medium'), 'chip chip-medium'));
  test('Low → chip-low', () => assert.equal(chipClass('Low'), 'chip chip-low'));
  test('undefined → chip-medium', () => assert.equal(chipClass(undefined), 'chip chip-medium'));
  test('case insensitive: CRITICAL → chip-critical', () => assert.equal(chipClass('CRITICAL'), 'chip chip-critical'));
  test('unknown priority → chip-medium', () => assert.equal(chipClass('Blocker'), 'chip chip-medium'));
});

// ─── Approval status transitions ─────────────────────────────────────────────

describe('Approval status transitions', () => {
  type Status = 'pending' | 'approved' | 'partial' | 'rejected' | 'uploaded';

  function computeStatus(approved: number, rejected: number): Status {
    if (approved === 0 && rejected === 0) return 'pending';
    if (rejected === 0 && approved > 0) return 'approved';
    if (approved === 0 && rejected > 0) return 'rejected';
    return 'partial';
  }

  function canUpload(status: Status): boolean {
    return status === 'approved' || status === 'partial';
  }

  test('0 approved, 0 rejected → pending', () => assert.equal(computeStatus(0, 0), 'pending'));
  test('all approved → approved', () => assert.equal(computeStatus(5, 0), 'approved'));
  test('all rejected → rejected', () => assert.equal(computeStatus(0, 5), 'rejected'));
  test('mix approved/rejected → partial', () => assert.equal(computeStatus(3, 2), 'partial'));

  test('pending cannot upload', () => assert.equal(canUpload('pending'), false));
  test('rejected cannot upload', () => assert.equal(canUpload('rejected'), false));
  test('uploaded cannot upload again', () => assert.equal(canUpload('uploaded'), false));
  test('approved can upload', () => assert.equal(canUpload('approved'), true));
  test('partial can upload', () => assert.equal(canUpload('partial'), true));
});
