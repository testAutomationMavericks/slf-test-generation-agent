/**
 * src/knowledge-base/formatters.ts
 *
 * Document formatters for the Knowledge Base.
 * Pure functions — no AWS, no external dependencies.
 * Used by both LocalKnowledgeBase (Phase 1) and PgKnowledgeBase (Phase 2).
 */

import { KBDocument, KBDocumentMetadata } from './types.js'

// ── formatTestCaseDocument ────────────────────────────────────────────────────

export function formatTestCaseDocument(
  content: string,
  meta: {
    jiraIssueKey: string
    approvedBy?: string
    projectKey?: string
    featureArea?: string
    component?: string
  }
): KBDocument {
  const now = new Date().toISOString()
  const id = `generated:${meta.jiraIssueKey}:${now}`
  const metadata: KBDocumentMetadata = {
    source: 'generated',
    jira_issue_key: meta.jiraIssueKey,
    jira_epic: '',
    feature_area: meta.featureArea ?? '',
    component: meta.component ?? '',
    approved_by: meta.approvedBy ?? '',
    project_key: meta.projectKey ?? meta.jiraIssueKey.split('-')[0],
    ingested_at: now,
    doc_type: 'test_case',
  }
  return { id, source: 'generated', content, metadata }
}

// ── formatJiraDocument ────────────────────────────────────────────────────────

export function formatJiraDocument(issue: {
  key: string
  summary: string
  description?: string | null
  priority?: { name: string } | null
  labels?: string[]
  components?: Array<{ name: string }>
  epic?: { key: string; summary: string } | null
}): KBDocument {
  const content = [
    `Jira Issue: ${issue.key}`,
    `Summary: ${issue.summary}`,
    issue.priority ? `Priority: ${issue.priority.name}` : '',
    issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : '',
    issue.components?.length ? `Components: ${issue.components.map(c => c.name).join(', ')}` : '',
    issue.epic ? `Epic: ${issue.epic.key} — ${issue.epic.summary}` : '',
    '',
    issue.description
      ? (typeof issue.description === 'string'
          ? issue.description
          : JSON.stringify(issue.description))
      : '',
  ].filter(l => l !== undefined).join('\n').trim()

  const now = new Date().toISOString()
  const metadata: KBDocumentMetadata = {
    source: 'jira',
    jira_issue_key: issue.key,
    jira_epic: issue.epic?.key ?? '',
    feature_area: issue.components?.[0]?.name ?? '',
    component: issue.components?.map(c => c.name).join(', ') ?? '',
    approved_by: '',
    project_key: issue.key.split('-')[0],
    ingested_at: now,
    doc_type: 'acceptance_criteria',
  }
  return { id: `jira:${issue.key}`, source: 'jira', content, metadata }
}

// ── formatConfluenceDocument ──────────────────────────────────────────────────

export function formatConfluenceDocument(page: {
  id: string
  title: string
  body?: string | null
  space?: string
  labels?: string[]
}): KBDocument {
  const content = [
    `Confluence Page: ${page.title}`,
    page.space ? `Space: ${page.space}` : '',
    page.labels?.length ? `Labels: ${page.labels.join(', ')}` : '',
    '',
    page.body ?? '',
  ].filter(l => l !== undefined).join('\n').trim()

  const now = new Date().toISOString()
  const metadata: KBDocumentMetadata = {
    source: 'confluence',
    jira_issue_key: '',
    jira_epic: '',
    feature_area: page.space ?? '',
    component: '',
    approved_by: '',
    project_key: '',
    ingested_at: now,
    doc_type: 'architecture',
  }
  return { id: `confluence:${page.id}`, source: 'confluence', content, metadata }
}

// ── formatZephyrDocument ──────────────────────────────────────────────────────

export function formatZephyrDocument(tc: {
  key: string
  name: string
  objective?: string | null
  precondition?: string | null
  steps?: Array<{ description: string; expectedResult: string }>
  labels?: string[]
  linkedIssues?: string[]
  priority?: { name: string } | null
}): KBDocument {
  const stepText = tc.steps?.length
    ? tc.steps.map((s, i) =>
        `Step ${i + 1}: ${s.description}\nExpected: ${s.expectedResult}`
      ).join('\n')
    : ''

  const content = [
    `Zephyr Test Case: ${tc.key}`,
    `Name: ${tc.name}`,
    tc.priority ? `Priority: ${tc.priority.name}` : '',
    tc.linkedIssues?.length ? `Linked Issues: ${tc.linkedIssues.join(', ')}` : '',
    tc.labels?.length ? `Labels: ${tc.labels.join(', ')}` : '',
    tc.precondition ? `\nPreconditions:\n${tc.precondition}` : '',
    stepText ? `\nTest Steps:\n${stepText}` : '',
    tc.objective ? `\nObjective:\n${tc.objective}` : '',
  ].filter(l => l !== undefined).join('\n').trim()

  const now = new Date().toISOString()
  const issueKey = tc.linkedIssues?.[0] ?? ''
  const metadata: KBDocumentMetadata = {
    source: 'zephyr',
    jira_issue_key: issueKey,
    jira_epic: '',
    feature_area: tc.labels?.[0] ?? '',
    component: '',
    approved_by: '',
    project_key: issueKey.split('-')[0],
    ingested_at: now,
    doc_type: 'test_case',
  }
  return { id: `zephyr:${tc.key}`, source: 'zephyr', content, metadata }
}
