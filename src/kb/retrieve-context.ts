/**
 * src/kb/retrieve-context.ts
 *
 * KB retrieval helpers — project/multi/all scope, context builder.
 * Used by ui/server.ts to inject KB context into generation prompts.
 */

import { logger } from '../logger.js'
import type { IKnowledgeBase, RetrieveOptions } from './interface.js'

// ─── Scope ────────────────────────────────────────────────────────────────────

export interface KBScope {
  mode: 'project' | 'multi' | 'all'
  projects?: string[]
}

// ─── Context Builder ──────────────────────────────────────────────────────────

export function buildKBContext(
  results: Array<{ content: string; score: number; metadata: Record<string, string> }>
): string {
  if (results.length === 0) return ''

  const grouped: Record<string, typeof results> = {}
  for (const r of results) {
    const src = r.metadata.source ?? 'unknown'
    if (!grouped[src]) grouped[src] = []
    grouped[src].push(r)
  }

  const labels: Record<string, string> = {
    generated:  'Previously Generated Test Cases',
    jira:       'Jira Acceptance Criteria',
    confluence: 'Confluence Documentation',
    zephyr:     'Existing Zephyr Test Cases',
  }

  const lines = [
    '## Relevant Knowledge Base Context\n',
    "_Retrieved from the team's knowledge base. Use to inform generation and avoid duplication._\n",
  ]

  for (const [src, items] of Object.entries(grouped)) {
    lines.push(`### ${labels[src] ?? src}`)
    for (const item of items) {
      const meta = item.metadata
      const header = [
        meta.jira_issue_key && `Issue: ${meta.jira_issue_key}`,
        meta.feature_area   && `Area: ${meta.feature_area}`,
        `Relevance: ${(item.score * 100).toFixed(0)}%`,
      ].filter(Boolean).join(' · ')
      lines.push(`\n_${header}_\n`)
      lines.push(item.content.slice(0, 1500))
      lines.push('')
    }
  }

  return lines.join('\n')
}

// ─── Retrieve ─────────────────────────────────────────────────────────────────

export async function retrieveKBContext(
  db: IKnowledgeBase,
  issueKey: string,
  projectKey: string,
  featureArea?: string,
  kbScope?: KBScope
): Promise<string> {
  const scopeOption: Partial<RetrieveOptions> =
    !kbScope || kbScope.mode === 'project'
      ? { filter: { project_key: projectKey } }
      : kbScope.mode === 'multi' && kbScope.projects?.length
        ? { projectKeys: kbScope.projects }
        : {} // 'all' — no project filter

  const [exact, similar] = await Promise.all([
    db.retrieve(`test cases for ${issueKey}`, {
      topK: 4,
      filter: { jira_issue_key: issueKey },
    }).catch(() => []),
    db.retrieve(`acceptance criteria and tests for ${featureArea ?? projectKey}`, {
      topK: kbScope?.mode === 'all' ? 10 : kbScope?.mode === 'multi' ? 8 : 6,
      minScore: 0.35,
      ...scopeOption,
    }).catch(() => []),
  ])

  const seen = new Set<string>()
  const all = [...exact, ...similar].filter(r => {
    const k = r.content.slice(0, 80)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  logger.info(`KB: ${all.length} docs retrieved for ${issueKey}`)
  return buildKBContext(all)
}
