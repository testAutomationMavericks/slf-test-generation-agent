// ui/client/src/lib/api.ts
import type {
  UIConfig, JiraIssue, ZephyrTestCase, KBStats,
  ServerStatus, ApprovalRequest, ReviewCase
} from '../types/api'

const BASE = ''

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  // Status & Config
  status: () => req<ServerStatus>('GET', '/api/status'),
  getConfig: () => req<UIConfig>('GET', '/api/config'),
  setConfig: (c: Partial<UIConfig>) => req<{ ok: boolean }>('POST', '/api/config', c),
  connect: () => req<{ ok: boolean }>('POST', '/api/connect'),
  checkClaudeCode: () => req<{ available: boolean; version?: string }>('GET', '/api/claudecode/check'),
  debug: () => req<Record<string, unknown>>('GET', '/api/debug'),

  // Jira
  jiraIssues: (jql?: string) => req<JiraIssue[]>('GET', '/api/jira/issues' + (jql ? `?jql=${encodeURIComponent(jql)}` : '')),
  jiraIssue: (key: string) => req<JiraIssue>('GET', `/api/jira/issue/${key}`),
  jiraComment: (issueKey: string, comment: string) =>
    req<{ commentId: string }>('POST', '/api/jira/comment', { issueKey, comment }),

  // Zephyr
  zephyrTests: (issueKey: string) => req<ZephyrTestCase[]>('GET', `/api/zephyr/testcases/${issueKey}`),
  zephyrCreate: (data: Record<string, unknown>) => req<{ created: ZephyrTestCase }>('POST', '/api/zephyr/create', data),

  // KB
  kbStats: () => req<KBStats>('GET', '/api/kb/stats'),
  kbList: () => req<string[]>('GET', '/api/kb/list'),
  kbSave: (content: string, issueKey: string, approvedBy: string) =>
    req<{ ok: boolean; stats: KBStats }>('POST', '/api/kb/save', { content, issueKey, approvedBy }),
  kbClear: () => req<{ ok: boolean }>('DELETE', '/api/kb/clear'),
  kbSeedStream: (): EventSource => new EventSource('/api/kb/seed'),

  // Approvals
  approvals: () => req<ApprovalRequest[]>('GET', '/api/approvals'),
  approval: (id: string) => req<ApprovalRequest>('GET', `/api/approvals/${id}`),
  createApproval: (data: {
    issueKey: string; issueSummary: string; projectKey: string
    folder: string; requestedBy: string; testCases: ReviewCase[]
  }) => req<{ id: string; url: string }>('POST', '/api/approvals', data),
  reviewApproval: (id: string, approverName: string, decisions: Array<{ id: number; approved: boolean; comment: string }>) =>
    req<{ ok: boolean; status: string; approvedCount: number; rejectedCount: number }>(
      'POST', `/api/approvals/${id}/review`, { approverName, decisions }
    ),
  uploadApproval: (id: string) =>
    req<{ ok: boolean; uploadedCount: number; failedCount: number; zephyrKeys: string[]; kbSaved: boolean; kbSavedCount: number; jiraCommentPosted: boolean }>(
      'POST', `/api/approvals/${id}/upload`, {}
    ),
  deleteApproval: (id: string) => req<{ ok: boolean }>('DELETE', `/api/approvals/${id}`),

  testJira: () =>
    fetch('/api/test/jira').then(r => r.json()) as Promise<{ ok: boolean; detail?: string; error?: string }>,
  testConfluence: () =>
    fetch('/api/test/confluence').then(r => r.json()) as Promise<{ ok: boolean; detail?: string; error?: string }>,
  testZephyr: () =>
    fetch('/api/test/zephyr').then(r => r.json()) as Promise<{ ok: boolean; detail?: string; error?: string }>,

  // Generate (SSE stream)
  generateStream: (issueKey: string | undefined, prompt: string): EventSource => {
    // POST with SSE requires fetch + ReadableStream (not EventSource)
    return null as unknown as EventSource // handled separately
  },
}

// Generate returns a ReadableStream (POST + SSE)
export async function* generateStream(issueKey: string | undefined, prompt: string, issueDetail?: unknown) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueKey, prompt, issueDetail }),
  })
  if (!res.ok) throw new Error(await res.text())
  if (!res.body) throw new Error('No response body')

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try { yield JSON.parse(line.slice(6)) } catch { /* skip */ }
    }
  }
}

// Parse test cases from Claude markdown output
export function parseTestCases(markdown: string, fallbackName?: string): ReviewCase[] {
  const blocks = markdown.split(/(?=^## )/m).filter(b => b.trim())
  const cases: ReviewCase[] = []

  for (const block of blocks) {
    const heading = block.split('\n')[0].replace(/^#+\s*/, '').trim()
    const match = heading.match(/(?:Test Case[:\s]+(?:TC-\w+\s+[-—]?\s*)?)?(.+)/i)
    const name = match?.[1]?.trim() ?? heading

    if (!name || name.length <= 3) continue

    const typeMatch = block.match(/\*\*Type:\*\*\s*([^\n*]+)/i)
    const priorityMatch = block.match(/\*\*Priority:\*\*\s*([^\n*]+)/i)

    const lines = block.split('\n')
    const preIdx = lines.findIndex(l => /precondition/i.test(l))
    const stepsIdx = lines.findIndex(l => /test steps|steps/i.test(l))
    const outcomeIdx = lines.findIndex(l => /expected outcome|outcome/i.test(l))

    const precondition = preIdx >= 0
      ? lines.slice(preIdx + 1, stepsIdx > preIdx ? stepsIdx : preIdx + 5)
          .filter(l => l.trim() && !l.startsWith('#'))
          .map(l => l.replace(/^[-*]\s*/, '')).join('\n')
      : ''

    const stepLines = lines.filter(l => /^\|\s*\d/.test(l))
    const steps = stepLines.map(l => {
      const cols = l.split('|').map(c => c.trim()).filter(Boolean)
      return { description: cols[1] || '', expectedResult: cols[2] || '' }
    })

    const outcome = outcomeIdx >= 0
      ? lines.slice(outcomeIdx + 1, outcomeIdx + 4)
          .filter(l => l.trim() && !l.startsWith('#')).join(' ')
      : ''

    cases.push({
      id: cases.length,
      name: name.slice(0, 120),
      type: typeMatch?.[1]?.trim() ?? 'Functional',
      priority: priorityMatch?.[1]?.trim() ?? 'Medium',
      precondition,
      steps,
      outcome,
      content: block.trim(),
      selected: true,
      uploaded: false,
      uploadError: null,
    })
  }

  if (cases.length === 0 && markdown.trim().length > 50) {
    cases.push({
      id: 0,
      name: fallbackName ?? 'Generated test cases',
      type: 'Functional', priority: 'Medium',
      precondition: '', steps: [], outcome: '',
      content: markdown.trim(),
      selected: true, uploaded: false, uploadError: null,
    })
  }

  return cases
}
