/**
 * tests/unit/formatters.test.ts
 *
 * Unit tests for src/knowledge-base/formatters.ts
 * All functions are pure — no external dependencies.
 *
 * Run: npm run test:unit
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatJiraDocument,
  formatConfluenceDocument,
  formatZephyrDocument,
  formatTestCaseDocument,
} from '../../src/knowledge-base/formatters.js';

// ─── formatJiraDocument ───────────────────────────────────────────────────────

describe('formatJiraDocument', () => {
  test('id is jira:<key>', () => {
    const doc = formatJiraDocument({ key: 'DEMO-1', summary: 'Login feature' });
    assert.equal(doc.id, 'jira:DEMO-1');
  });

  test('source field is "jira"', () => {
    const doc = formatJiraDocument({ key: 'DEMO-1', summary: 'Login feature' });
    assert.equal(doc.source, 'jira');
  });

  test('content includes key and summary', () => {
    const doc = formatJiraDocument({ key: 'DEMO-2', summary: 'Add Item to Basket' });
    assert.ok(doc.content.includes('DEMO-2'));
    assert.ok(doc.content.includes('Add Item to Basket'));
  });

  test('content includes priority when provided', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      priority: { name: 'High' },
    });
    assert.ok(doc.content.includes('Priority: High'));
  });

  test('content includes labels when provided', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      labels: ['authentication', 'security'],
    });
    assert.ok(doc.content.includes('authentication'));
    assert.ok(doc.content.includes('security'));
  });

  test('content includes components when provided', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      components: [{ name: 'auth-service' }],
    });
    assert.ok(doc.content.includes('auth-service'));
  });

  test('content includes epic key and summary when provided', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      epic: { key: 'EPIC-1', summary: 'Authentication Epic' },
    });
    assert.ok(doc.content.includes('EPIC-1'));
    assert.ok(doc.content.includes('Authentication Epic'));
  });

  test('content includes description when provided', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      description: 'User must be able to log in with email and password.',
    });
    assert.ok(doc.content.includes('User must be able to log in'));
  });

  test('metadata project_key is derived from issue key', () => {
    const doc = formatJiraDocument({ key: 'DEMO-3', summary: 'Checkout' });
    assert.equal(doc.metadata.project_key, 'DEMO');
  });

  test('metadata doc_type is acceptance_criteria', () => {
    const doc = formatJiraDocument({ key: 'DEMO-1', summary: 'Login' });
    assert.equal(doc.metadata.doc_type, 'acceptance_criteria');
  });

  test('metadata feature_area uses first component name', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      components: [{ name: 'auth-service' }, { name: 'api-gateway' }],
    });
    assert.equal(doc.metadata.feature_area, 'auth-service');
  });

  test('metadata jira_epic uses epic key', () => {
    const doc = formatJiraDocument({
      key: 'DEMO-1',
      summary: 'Login',
      epic: { key: 'EPIC-5', summary: 'Auth' },
    });
    assert.equal(doc.metadata.jira_epic, 'EPIC-5');
  });

  test('optional fields default gracefully when omitted', () => {
    const doc = formatJiraDocument({ key: 'DEMO-1', summary: 'Minimal issue' });
    assert.ok(doc.content.length > 0);
    assert.equal(doc.metadata.feature_area, '');
    assert.equal(doc.metadata.jira_epic, '');
  });
});

// ─── formatConfluenceDocument ─────────────────────────────────────────────────

describe('formatConfluenceDocument', () => {
  test('id is confluence:<pageId>', () => {
    const doc = formatConfluenceDocument({ id: 'page-123', title: 'Auth Architecture' });
    assert.equal(doc.id, 'confluence:page-123');
  });

  test('source field is "confluence"', () => {
    const doc = formatConfluenceDocument({ id: 'page-123', title: 'Auth Architecture' });
    assert.equal(doc.source, 'confluence');
  });

  test('content includes page title', () => {
    const doc = formatConfluenceDocument({ id: 'page-123', title: 'Auth Architecture' });
    assert.ok(doc.content.includes('Auth Architecture'));
  });

  test('content includes space when provided', () => {
    const doc = formatConfluenceDocument({
      id: 'page-123',
      title: 'Auth Architecture',
      space: 'ENG',
    });
    assert.ok(doc.content.includes('ENG'));
  });

  test('content includes labels when provided', () => {
    const doc = formatConfluenceDocument({
      id: 'page-123',
      title: 'Auth Architecture',
      labels: ['security', 'auth'],
    });
    assert.ok(doc.content.includes('security'));
    assert.ok(doc.content.includes('auth'));
  });

  test('content includes body text when provided', () => {
    const doc = formatConfluenceDocument({
      id: 'page-123',
      title: 'Auth Architecture',
      body: 'OAuth2 flow is used for all API authentication.',
    });
    assert.ok(doc.content.includes('OAuth2 flow'));
  });

  test('metadata doc_type is architecture', () => {
    const doc = formatConfluenceDocument({ id: 'p1', title: 'Infra Overview' });
    assert.equal(doc.metadata.doc_type, 'architecture');
  });

  test('metadata feature_area uses space', () => {
    const doc = formatConfluenceDocument({ id: 'p1', title: 'Infra', space: 'PLATFORM' });
    assert.equal(doc.metadata.feature_area, 'PLATFORM');
  });

  test('metadata jira_issue_key is empty string', () => {
    const doc = formatConfluenceDocument({ id: 'p1', title: 'Infra' });
    assert.equal(doc.metadata.jira_issue_key, '');
  });

  test('handles missing body gracefully', () => {
    const doc = formatConfluenceDocument({ id: 'p1', title: 'Empty Page', body: null });
    assert.ok(doc.content.includes('Empty Page'));
  });
});

// ─── formatZephyrDocument ─────────────────────────────────────────────────────

describe('formatZephyrDocument', () => {
  test('id is zephyr:<key>', () => {
    const doc = formatZephyrDocument({ key: 'DEMO-T1', name: 'Login with valid credentials' });
    assert.equal(doc.id, 'zephyr:DEMO-T1');
  });

  test('source field is "zephyr"', () => {
    const doc = formatZephyrDocument({ key: 'DEMO-T1', name: 'Login test' });
    assert.equal(doc.source, 'zephyr');
  });

  test('content includes test case key and name', () => {
    const doc = formatZephyrDocument({ key: 'DEMO-T1', name: 'Successful login' });
    assert.ok(doc.content.includes('DEMO-T1'));
    assert.ok(doc.content.includes('Successful login'));
  });

  test('content includes priority when provided', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      priority: { name: 'Critical' },
    });
    assert.ok(doc.content.includes('Critical'));
  });

  test('content includes linked issues when provided', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      linkedIssues: ['DEMO-1', 'DEMO-4'],
    });
    assert.ok(doc.content.includes('DEMO-1'));
    assert.ok(doc.content.includes('DEMO-4'));
  });

  test('content includes precondition when provided', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      precondition: 'User must have a registered account',
    });
    assert.ok(doc.content.includes('User must have a registered account'));
  });

  test('content includes step descriptions and expected results', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      steps: [
        { description: 'Enter valid email', expectedResult: 'Email field accepts input' },
        { description: 'Click Login button', expectedResult: 'User is redirected to dashboard' },
      ],
    });
    assert.ok(doc.content.includes('Enter valid email'));
    assert.ok(doc.content.includes('User is redirected to dashboard'));
    assert.ok(doc.content.includes('Step 1'));
    assert.ok(doc.content.includes('Step 2'));
  });

  test('content includes objective when provided', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      objective: 'Verify authentication succeeds with correct credentials',
    });
    assert.ok(doc.content.includes('Verify authentication succeeds'));
  });

  test('metadata doc_type is test_case', () => {
    const doc = formatZephyrDocument({ key: 'DEMO-T1', name: 'Login test' });
    assert.equal(doc.metadata.doc_type, 'test_case');
  });

  test('metadata jira_issue_key uses first linked issue', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      linkedIssues: ['DEMO-1'],
    });
    assert.equal(doc.metadata.jira_issue_key, 'DEMO-1');
  });

  test('metadata project_key is derived from first linked issue', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      linkedIssues: ['DEMO-1'],
    });
    assert.equal(doc.metadata.project_key, 'DEMO');
  });

  test('metadata feature_area uses first label', () => {
    const doc = formatZephyrDocument({
      key: 'DEMO-T1',
      name: 'Login test',
      labels: ['authentication', 'regression'],
    });
    assert.equal(doc.metadata.feature_area, 'authentication');
  });

  test('handles test case with no steps gracefully', () => {
    const doc = formatZephyrDocument({ key: 'DEMO-T1', name: 'Login test', steps: [] });
    assert.ok(doc.content.length > 0);
    assert.ok(!doc.content.includes('Step 1'));
  });
});

// ─── formatTestCaseDocument ───────────────────────────────────────────────────

describe('formatTestCaseDocument', () => {
  test('id starts with "generated:" and includes jiraIssueKey', () => {
    const doc = formatTestCaseDocument('Test content here', { jiraIssueKey: 'DEMO-3' });
    assert.ok(doc.id.startsWith('generated:DEMO-3:'));
  });

  test('source field is "generated"', () => {
    const doc = formatTestCaseDocument('Test content', { jiraIssueKey: 'DEMO-3' });
    assert.equal(doc.source, 'generated');
  });

  test('content is preserved verbatim', () => {
    const content = '## Test Case: Login\n\nStep 1: Navigate to /login';
    const doc = formatTestCaseDocument(content, { jiraIssueKey: 'DEMO-1' });
    assert.equal(doc.content, content);
  });

  test('metadata doc_type is test_case', () => {
    const doc = formatTestCaseDocument('content', { jiraIssueKey: 'DEMO-1' });
    assert.equal(doc.metadata.doc_type, 'test_case');
  });

  test('metadata approved_by is set when provided', () => {
    const doc = formatTestCaseDocument('content', {
      jiraIssueKey: 'DEMO-1',
      approvedBy: 'qa-lead@example.com',
    });
    assert.equal(doc.metadata.approved_by, 'qa-lead@example.com');
  });

  test('metadata project_key uses projectKey when provided', () => {
    const doc = formatTestCaseDocument('content', {
      jiraIssueKey: 'DEMO-1',
      projectKey: 'DEMO',
    });
    assert.equal(doc.metadata.project_key, 'DEMO');
  });

  test('metadata project_key falls back to prefix of jiraIssueKey', () => {
    const doc = formatTestCaseDocument('content', { jiraIssueKey: 'SLF-42' });
    assert.equal(doc.metadata.project_key, 'SLF');
  });

  test('metadata feature_area uses featureArea when provided', () => {
    const doc = formatTestCaseDocument('content', {
      jiraIssueKey: 'DEMO-1',
      featureArea: 'authentication',
    });
    assert.equal(doc.metadata.feature_area, 'authentication');
  });
});
