// ui/client/src/pages/ApprovalsPage.tsx
import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { ApprovalRequest } from '../types/api'
import type { Page } from '../App'

interface Props { onNav: (p: Page) => void }

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  pending:  { bg: 'rgba(240,172,58,.12)', color: 'var(--amber)' },
  approved: { bg: 'rgba(39,201,143,.1)', color: 'var(--green)' },
  partial:  { bg: 'rgba(124,106,247,.1)', color: 'var(--accent)' },
  rejected: { bg: 'rgba(224,85,85,.1)', color: 'var(--red)' },
  uploaded: { bg: 'rgba(168,124,245,.1)', color: 'var(--purple)' },
}

export function ApprovalsPage({ onNav }: Props) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [uploading, setUploading] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  const load = async () => {
    try { setApprovals(await api.approvals()) } catch { /* ignore */ }
  }

  const handleUpload = async (id: string) => {
    setUploading(id)
    try {
      const r = await api.uploadApproval(id)
      const parts = []
      if (r.uploadedCount) parts.push(`${r.uploadedCount} uploaded`)
      if (r.kbSaved) parts.push(`${r.kbSavedCount} to KB`)
      if (r.jiraCommentPosted) parts.push('Jira comment posted')
      alert('✓ ' + parts.join(' · '))
      await load()
    } catch (e: unknown) {
      alert('Upload failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setUploading(null)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this approval request?')) return
    await api.deleteApproval(id)
    await load()
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '14px 22px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)', display: 'flex', alignItems: 'center',
        gap: 10, flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Approval Requests</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
            Tests waiting for teammate review before Zephyr upload
          </div>
        </div>
        <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={load}>↻ Refresh</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
        {approvals.length === 0 && (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>
            No approval requests yet.{' '}
            <button
              onClick={() => onNav('console')}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, fontFamily: 'var(--sans)' }}
            >
              Generate tests
            </button>{' '}
            and click "Send for Approval".
          </div>
        )}

        {approvals.map(apr => {
          const st = STATUS_STYLES[apr.status] ?? STATUS_STYLES.pending
          const canUpload = apr.status === 'approved' || apr.status === 'partial'
          const approvalUrl = `${window.location.origin}/approve/${apr.id}`

          return (
            <div key={apr.id} style={{
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 8, marginBottom: 10, overflow: 'hidden',
            }}>
              <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', marginRight: 8 }}>{apr.issueKey}</span>
                    {apr.issueSummary}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 3 }}>
                    {apr.testCases.length} tests · {new Date(apr.requestedAt).toLocaleString()} · by {apr.requestedBy}
                  </div>
                </div>
                <span style={{
                  padding: '2px 10px', borderRadius: 3, fontSize: 11,
                  fontWeight: 600, fontFamily: 'var(--mono)',
                  background: st.bg, color: st.color,
                }}>
                  {apr.status}
                </span>
              </div>

              <div style={{ padding: '0 16px 12px', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <a
                  href={approvalUrl} target="_blank" rel="noreferrer"
                  className="btn btn-secondary"
                  style={{ textDecoration: 'none', fontSize: 11 }}
                >
                  🔗 Open Approval Page
                </a>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11 }}
                  onClick={() => { navigator.clipboard.writeText(approvalUrl) }}
                >
                  📋 Copy Link
                </button>
                {canUpload && (
                  <button
                    className="btn btn-success"
                    style={{ fontSize: 11 }}
                    onClick={() => handleUpload(apr.id)}
                    disabled={uploading === apr.id}
                  >
                    {uploading === apr.id ? <span className="spinner" style={{ color: 'var(--green)' }} /> : '↑'}
                    Upload Approved
                  </button>
                )}
                {apr.status === 'uploaded' && apr.zephyrKeys && (
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    ✓ {apr.zephyrKeys.join(', ')}
                  </span>
                )}
                <button
                  className="btn btn-danger"
                  style={{ fontSize: 11, marginLeft: 'auto' }}
                  onClick={() => handleDelete(apr.id)}
                >
                  ✕
                </button>
              </div>

              {apr.status === 'uploaded' && (
                <div style={{
                  padding: '6px 16px 10px',
                  fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)',
                  borderTop: '1px solid var(--border)',
                }}>
                  Approved by {apr.approvedBy} · Jira comment posted · KB updated
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
