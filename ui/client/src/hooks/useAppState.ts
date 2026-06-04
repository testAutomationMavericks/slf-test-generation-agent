// ui/client/src/hooks/useAppState.ts
import { useState, useCallback, useRef } from 'react'
import { api, generateStream, parseTestCases } from '../lib/api'
import type { JiraIssue, ZephyrTestCase, ServerStatus, KBStats, ReviewCase } from '../types/api'

export function useAppState() {
  // Connection
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [connecting, setConnecting] = useState(false)

  // Issues
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null)
  const [issueDetail, setIssueDetail] = useState<JiraIssue | null>(null)

  // Zephyr
  const [zephyrTests, setZephyrTests] = useState<ZephyrTestCase[]>([])
  const [sessionUploads, setSessionUploads] = useState<ZephyrTestCase[]>([])

  // Generation
  const [generating, setGenerating] = useState(false)
  const [output, setOutput] = useState('')
  const [engine, setEngine] = useState<string>('')
  const [kbDocsFound, setKbDocsFound] = useState(0)

  // KB
  const [kbStats, setKbStats] = useState<KBStats>({ total: 0 })

  // Review
  const [reviewCases, setReviewCases] = useState<ReviewCase[]>([])
  const [curApprovalId, setCurApprovalId] = useState<string | null>(null)
  const [approvalStatus, setApprovalStatus] = useState<string>('')

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeIssueKey = useRef<string | null>(null)

  // ── Status ──────────────────────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      const s = await api.status()
      setStatus(s)
      setKbStats(s.kb)
    } catch { /* server might not be ready */ }
  }, [])

  // ── Issues ──────────────────────────────────────────────────────────────────
  const loadIssues = useCallback(async () => {
    setConnecting(true)
    try {
      const list = await api.jiraIssues()
      setIssues(list)
      await loadStatus()
    } catch (e) {
      console.error('Failed to load issues', e)
    } finally {
      setConnecting(false)
    }
  }, [loadStatus])

  const selectIssue = useCallback(async (issue: JiraIssue) => {
    activeIssueKey.current = issue.key
    setSelectedIssue(issue)
    setOutput('')
    setReviewCases([])
    setCurApprovalId(null)
    setApprovalStatus('')
    setZephyrTests([])
    setSessionUploads([])
    try {
      const detail = await api.jiraIssue(issue.key)
      if (activeIssueKey.current !== issue.key) return
      setIssueDetail(detail)
      const tests = await api.zephyrTests(issue.key)
      if (activeIssueKey.current !== issue.key) return
      setZephyrTests(tests)
    } catch (e) {
      console.error('Failed to load issue detail', e)
    }
  }, [])

  const reloadZephyr = useCallback(async (issueKey: string) => {
    try {
      const tests = await api.zephyrTests(issueKey)
      if (activeIssueKey.current !== issueKey) return
      setZephyrTests(tests)
    } catch { /* ignore */ }
  }, [])

  // ── Generate ─────────────────────────────────────────────────────────────────
  const generate = useCallback(async (prompt?: string) => {
    if (!issueDetail) return
    setGenerating(true)
    setOutput('')
    setKbDocsFound(0)

    const fullPrompt = prompt ?? (
      `Generate comprehensive test cases for Jira issue ${issueDetail.key}. ` +
      `Fetch the ticket, check Confluence for architecture context, retrieve existing Zephyr test cases, ` +
      `then generate test cases covering all acceptance criteria, edge cases, and negative tests. ` +
      `Follow the structure in CLAUDE.md.`
    )

    try {
      let full = ''
      for await (const ev of generateStream(issueDetail.key, fullPrompt, issueDetail)) {
        if (ev.type === 'mode') setEngine(ev.engine ?? '')
        else if (ev.type === 'chunk') { full += ev.text ?? ''; setOutput(full) }
        else if (ev.type === 'kb_context') setKbDocsFound(ev.count ?? 0)
        else if (ev.type === 'done') break
        else if (ev.type === 'error') throw new Error(ev.message)
      }
      setOutput(full)
    } catch (e) {
      console.error('Generate failed', e)
      throw e
    } finally {
      setGenerating(false)
    }
  }, [issueDetail])

  // ── Review cases ─────────────────────────────────────────────────────────────
  const openReview = useCallback(() => {
    const cases = parseTestCases(output, issueDetail ? `Tests for ${issueDetail.key}` : undefined)
    setReviewCases(cases)
    setCurApprovalId(null)
    setApprovalStatus('')
  }, [output, issueDetail])

  const updateReviewCase = useCallback((id: number, updates: Partial<ReviewCase>) => {
    setReviewCases(prev => prev.map(tc => tc.id === id ? { ...tc, ...updates } : tc))
  }, [])

  // ── Send for approval ─────────────────────────────────────────────────────────
  const sendForApproval = useCallback(async (requestedBy: string, folder: string) => {
    if (!issueDetail) throw new Error('No issue selected')
    const selected = reviewCases.filter(tc => tc.selected && !tc.uploaded)
    if (!selected.length) throw new Error('No test cases selected')

    const r = await api.createApproval({
      issueKey: issueDetail.key,
      issueSummary: issueDetail.summary,
      projectKey: issueDetail.key.split('-')[0],
      folder,
      requestedBy,
      testCases: selected,
    })

    setCurApprovalId(r.id)
    setApprovalStatus('pending')

    // Poll for approval
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const apr = await api.approval(r.id)
        if (apr.status === 'approved' || apr.status === 'partial') {
          clearInterval(pollRef.current!)
          setApprovalStatus('approved')
        } else if (apr.status === 'rejected') {
          clearInterval(pollRef.current!)
          setApprovalStatus('rejected')
        }
      } catch { clearInterval(pollRef.current!) }
    }, 3000)

    return r
  }, [issueDetail, reviewCases])

  // ── Upload approved ───────────────────────────────────────────────────────────
  const uploadApproved = useCallback(async () => {
    if (!curApprovalId || !issueDetail) throw new Error('No approval request')

    const r = await api.uploadApproval(curApprovalId)

    // Fetch full approval to get uploaded keys and mark cases
    const apr = await api.approval(curApprovalId)
    const approvedCases = reviewCases.filter(tc => tc.selected && !tc.uploaded)

    ;(apr.zephyrKeys ?? []).forEach((key, i) => {
      const tc = approvedCases[i]
      if (!tc) return
      updateReviewCase(tc.id, { uploaded: true, uploadedKey: key, kbSaved: true })
      setSessionUploads(prev => [...prev, {
        key,
        name: tc.name,
        objective: tc.content.slice(0, 200),
        precondition: tc.precondition,
        priority: { name: tc.priority },
        status: { name: 'Approved' },
        folder: { name: 'Generated' },
        steps: tc.steps,
        labels: ['approved', 'test-agent'],
        issueKey: issueDetail.key,
        _new: true,
      }])
    })

    setApprovalStatus('uploaded')

    // Refresh Zephyr panel
    await reloadZephyr(issueDetail.key)
    setTimeout(() => reloadZephyr(issueDetail.key), 800)

    // Refresh KB stats
    const stats = await api.kbStats()
    setKbStats(stats)

    return r
  }, [curApprovalId, issueDetail, reviewCases, updateReviewCase, reloadZephyr])

  // ── KB ────────────────────────────────────────────────────────────────────────
  const loadKBStats = useCallback(async () => {
    try { setKbStats(await api.kbStats()) } catch { /* ignore */ }
  }, [])

  // ── Reconnect ─────────────────────────────────────────────────────────────────
  const reconnect = useCallback(async () => {
    try { await api.connect(); await loadIssues() } catch (e) { throw e }
  }, [loadIssues])

  return {
    status, connecting, issues, selectedIssue, issueDetail,
    zephyrTests, sessionUploads, setSessionUploads,
    generating, output, engine, kbDocsFound,
    kbStats, loadKBStats,
    reviewCases, setReviewCases, updateReviewCase,
    curApprovalId, approvalStatus,
    loadStatus, loadIssues, selectIssue, reloadZephyr,
    generate, openReview, sendForApproval, uploadApproved,
    reconnect,
  }
}
