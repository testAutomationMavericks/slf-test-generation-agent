// ui/client/src/components/ReviewModal.tsx
import { useState, useEffect, useCallback } from 'react'
import type { ReviewCase } from '../types/api'

interface Props {
  cases: ReviewCase[]
  issueKey: string
  onClose: () => void
  onUpdate: (id: number, updates: Partial<ReviewCase>) => void
  onSendApproval: (requestedBy: string, folder: string) => Promise<{ id: string; url: string }>
  onUploadApproved: () => Promise<unknown>
  approvalStatus: string
  curApprovalId: string | null
}

export function ReviewModal({
  cases, issueKey, onClose, onUpdate,
  onSendApproval, onUploadApproved, approvalStatus, curApprovalId,
}: Props) {
  const [page, setPage] = useState(0)
  const [folder, setFolder] = useState('Generated')
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null)

  const tc = cases[page]
  const selected = cases.filter(c => c.selected && !c.uploaded)
  const uploaded = cases.filter(c => c.uploaded)

  useEffect(() => { setPage(0) }, [cases.length])

  const saveCurrent = useCallback(() => {
    const name = (document.getElementById('ef-name') as HTMLInputElement)?.value
    const pri = (document.getElementById('ef-priority') as HTMLSelectElement)?.value
    const type = (document.getElementById('ef-type') as HTMLSelectElement)?.value
    const pre = (document.getElementById('ef-pre') as HTMLTextAreaElement)?.value
    const con = (document.getElementById('ef-content') as HTMLTextAreaElement)?.value
    if (!tc) return
    onUpdate(tc.id, {
      name: name ?? tc.name, priority: pri ?? tc.priority,
      type: type ?? tc.type, precondition: pre ?? tc.precondition,
      content: con ?? tc.content,
    })
  }, [tc, onUpdate])

  const navigate = (dir: number) => {
    saveCurrent()
    setPage(p => Math.max(0, Math.min(cases.length - 1, p + dir)))
  }

  const goTo = (i: number) => { saveCurrent(); setPage(i) }

  const handleSendApproval = async () => {
    const name = prompt('Your name / ID:')
    if (!name) return
    setSending(true)
    try {
      const r = await onSendApproval(name, folder)
      const url = `${window.location.origin}/approve/${r.id}`
      setApprovalUrl(url)
      await navigator.clipboard.writeText(url).catch(() => {})
    } catch (e: unknown) {
      alert('Failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  const handleUpload = async () => {
    setUploading(true)
    try { await onUploadApproved() } catch (e: unknown) {
      alert('Upload failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setUploading(false) }
  }

  const chipClass = (p: string) => {
    const l = p.toLowerCase()
    return l === 'critical' ? 'chip chip-critical' : l === 'high' ? 'chip chip-high'
      : l === 'low' ? 'chip chip-low' : 'chip chip-medium'
  }

  if (!tc) return null

  const apvBadge = approvalStatus === 'approved' || approvalStatus === 'partial'
    ? <span className="chip chip-green">✓ Approved — ready to upload</span>
    : approvalStatus === 'rejected'
    ? <span className="chip chip-red">✗ Rejected</span>
    : approvalStatus === 'pending' && curApprovalId
    ? <span className="chip chip-amber">⏳ Awaiting review</span>
    : approvalStatus === 'uploaded'
    ? <span className="chip chip-purple">✓ Uploaded</span>
    : null

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)',
        zIndex: 300, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 20, backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 12, width: '100%', maxWidth: 900,
        height: 'calc(100vh - 40px)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 32px 80px rgba(0,0,0,.6)',
        animation: 'slideUp .2s ease',
      }}>

        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Review & Upload to Zephyr</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              {cases.length} test cases · {selected.length} selected · {uploaded.length} uploaded
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Folder</label>
            <input className="input" value={folder} onChange={e => setFolder(e.target.value)}
              style={{ width: 110, fontSize: 11 }} />
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text2)',
            fontSize: 20, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
          }}>✕</button>
        </div>

        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--border)', flexShrink: 0 }}>
          <div style={{
            height: '100%', transition: 'width .3s',
            background: 'linear-gradient(90deg, var(--accent), var(--green))',
            width: `${(uploaded.length / Math.max(cases.length, 1)) * 100}%`,
          }} />
        </div>

        {/* Thumbnail strip */}
        <div style={{
          display: 'flex', gap: 4, padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto', flexShrink: 0,
          background: 'var(--bg3)',
        }}>
          {cases.map((c, i) => (
            <button key={c.id} onClick={() => goTo(i)} style={{
              width: 30, height: 30, borderRadius: 5, flexShrink: 0,
              border: `1.5px solid ${i === page ? 'var(--accent)' : c.uploaded ? 'var(--green)' : c.uploadError ? 'var(--red)' : c.selected ? 'var(--border3)' : 'var(--border)'}`,
              background: i === page ? 'rgba(124,106,247,.1)' : c.uploaded ? 'rgba(39,201,143,.1)' : 'var(--bg4)',
              color: i === page ? 'var(--accent)' : c.uploaded ? 'var(--green)' : c.uploadError ? 'var(--red)' : 'var(--text3)',
              fontFamily: 'var(--mono)', fontSize: 9, cursor: 'pointer',
              transition: 'all .12s',
            }}>
              {c.uploaded ? '✓' : c.uploadError ? '✗' : i + 1}
            </button>
          ))}
        </div>

        {/* Main content — single test */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* Test header */}
          <div style={{
            padding: '14px 20px 10px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)', flexShrink: 0,
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 6, lineHeight: 1.3 }}>
              {tc.name}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={chipClass(tc.priority)}>{tc.priority}</span>
              <span className="chip" style={{ background: 'var(--bg5)', color: 'var(--text3)' }}>{tc.type}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                TC-{String(page + 1).padStart(3, '0')}
              </span>
              {tc.uploaded && <span className="chip chip-green">✓ Zephyr + KB</span>}
              {tc.uploadError && <span className="chip chip-red" title={tc.uploadError}>✗ Failed</span>}
            </div>
          </div>

          {/* Editable fields */}
          <div style={{ padding: '16px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              {[
                { label: 'Name', id: 'ef-name', type: 'input', defaultValue: tc.name },
                { label: 'Priority', id: 'ef-priority', type: 'select', options: ['Critical','High','Medium','Low'], defaultValue: tc.priority },
                { label: 'Type', id: 'ef-type', type: 'select', options: ['Functional','Regression','Negative','Edge Case','Security','Performance'], defaultValue: tc.type },
              ].map(f => (
                <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)' }}>{f.label}</label>
                  {f.type === 'input'
                    ? <input key={`${tc.id}-${f.id}`} id={f.id} className="input" defaultValue={f.defaultValue} disabled={tc.uploaded} />
                    : <select key={`${tc.id}-${f.id}`} id={f.id} className="input" defaultValue={f.defaultValue} disabled={tc.uploaded}>
                        {f.options?.map(o => <option key={o}>{o}</option>)}
                      </select>
                  }
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)' }}>Preconditions</label>
              <textarea key={`${tc.id}-pre`} id="ef-pre" className="input" rows={2} defaultValue={tc.precondition} disabled={tc.uploaded} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)' }}>Full Content</label>
              <textarea key={`${tc.id}-content`} id="ef-content" className="input" style={{ flex: 1, minHeight: 160, fontSize: 11 }} defaultValue={tc.content} disabled={tc.uploaded} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
          background: 'var(--bg2)', flexWrap: 'wrap',
        }}>
          {/* Page nav */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button className="btn btn-secondary" style={{ padding: '4px 10px' }} onClick={() => navigate(-1)} disabled={page === 0}>‹</button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', padding: '0 8px', minWidth: 52, textAlign: 'center' }}>
              {page + 1} / {cases.length}
            </span>
            <button className="btn btn-secondary" style={{ padding: '4px 10px' }} onClick={() => navigate(1)} disabled={page === cases.length - 1}>›</button>
          </div>

          {/* Include toggle */}
          <button
            onClick={() => { saveCurrent(); onUpdate(tc.id, { selected: !tc.selected }) }}
            disabled={tc.uploaded}
            style={{
              padding: '5px 12px', borderRadius: 6, border: `1.5px solid ${tc.selected && !tc.uploaded ? 'var(--accent)' : 'var(--border2)'}`,
              background: tc.selected && !tc.uploaded ? 'rgba(124,106,247,.08)' : 'var(--bg4)',
              color: tc.selected && !tc.uploaded ? 'var(--accent)' : 'var(--text2)',
              fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ width: 14, height: 14, border: `2px solid currentColor`, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700 }}>
              {tc.selected && !tc.uploaded ? '✓' : ''}
            </span>
            {tc.uploaded ? 'Uploaded' : tc.selected ? 'Include' : 'Excluded'}
          </button>

          <div style={{ width: 1, height: 22, background: 'var(--border)' }} />

          {/* Send for approval */}
          <button className="btn btn-primary" onClick={handleSendApproval} disabled={sending || !selected.length}>
            {sending ? <span className="spinner" /> : '📨'} Send for Approval
          </button>

          {/* Upload approved */}
          <button
            className="btn btn-success"
            onClick={handleUpload}
            disabled={uploading || !(approvalStatus === 'approved' || approvalStatus === 'partial')}
            title={!(approvalStatus === 'approved' || approvalStatus === 'partial') ? 'Requires approval first' : ''}
          >
            {uploading ? <span className="spinner" style={{ color: 'var(--green)' }} /> : '↑'} Upload Approved
          </button>

          <button className="btn btn-ghost" onClick={onClose}>Done</button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {apvBadge}
            {approvalUrl && approvalStatus === 'pending' && (
              <a href={approvalUrl} target="_blank" rel="noreferrer"
                style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--accent)', textDecoration: 'none' }}>
                Open approval page ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
