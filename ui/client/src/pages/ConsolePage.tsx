// ui/client/src/pages/ConsolePage.tsx
import { useState, useRef, useEffect } from 'react'
import type { useAppState } from '../hooks/useAppState'
import { ReviewModal } from '../components/ReviewModal'
import { api } from '../lib/api'
import type { ZephyrTestCase } from '../types/api'

type State = ReturnType<typeof useAppState>

interface Props { state: State }

export function ConsolePage({ state }: Props) {
  const [showReview, setShowReview] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [viewTest, setViewTest] = useState<ZephyrTestCase | null>(null)
  const [error, setError] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [state.output])

  const allZephyr = [...state.zephyrTests, ...state.sessionUploads]

  const handleGenerate = async () => {
    setError('')
    try {
      await state.generate(customPrompt || undefined)
      setCustomPrompt('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleUpdate = async () => {
    if (!state.issueDetail) return
    setError('')
    try {
      await state.generate(
        `Review and update test cases for ${state.issueDetail.key}. ` +
        `Check current Zephyr tests, identify gaps against the latest acceptance criteria, ` +
        `and generate an updated suite.`
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const chipPriority = (p?: string) => {
    const l = (p ?? 'medium').toLowerCase()
    return l === 'critical' ? 'chip chip-critical' : l === 'high' ? 'chip chip-high'
      : l === 'low' ? 'chip chip-low' : 'chip chip-medium'
  }

  const noIssue = !state.issueDetail

  return (
    <>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left: output area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid var(--border)' }}>

          {/* Issue detail */}
          <div style={{
            padding: '12px 18px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)', flexShrink: 0,
            minHeight: 72, maxHeight: 160, overflowY: 'auto',
          }}>
            {noIssue ? (
              <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic', paddingTop: 8 }}>
                ← Select a Jira issue to begin
              </div>
            ) : (
              <>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 3 }}>
                  {state.issueDetail!.key}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, lineHeight: 1.3 }}>
                  {state.issueDetail!.summary}
                </div>
                {state.issueDetail!.description && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)',
                    lineHeight: 1.65, whiteSpace: 'pre-wrap',
                    background: 'var(--bg3)', padding: '7px 10px', borderRadius: 5,
                    border: '1px solid var(--border)', maxHeight: 70, overflowY: 'auto',
                  }}>
                    {typeof state.issueDetail!.description === 'string'
                      ? state.issueDetail!.description.slice(0, 600)
                      : JSON.stringify(state.issueDetail!.description).slice(0, 600)}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Engine banner */}
          <div style={{
            padding: '6px 14px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg3)', display: 'flex', alignItems: 'center', gap: 10,
            flexShrink: 0, fontSize: 11, color: 'var(--text3)',
          }}>
            <span>Engine:</span>
            {state.engine && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                color: 'var(--cyan)', background: 'rgba(34,212,238,.06)',
                padding: '1px 7px', borderRadius: 3,
                border: '1px solid rgba(34,212,238,.15)',
              }}>
                {state.engine}
              </span>
            )}
            {state.kbDocsFound > 0 && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10, marginLeft: 'auto',
                color: 'var(--green)', background: 'rgba(39,201,143,.06)',
                padding: '1px 7px', borderRadius: 3,
                border: '1px solid rgba(39,201,143,.2)',
              }}>
                📚 KB: {state.kbDocsFound} docs
              </span>
            )}
          </div>

          {/* Toolbar */}
          <div style={{
            padding: '8px 14px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)', display: 'flex', gap: 7,
            alignItems: 'center', flexShrink: 0, flexWrap: 'wrap',
          }}>
            <button className="btn btn-primary" onClick={handleGenerate} disabled={noIssue || state.generating}>
              {state.generating ? <span className="spinner" /> : '⚡'} Generate Tests
            </button>
            <button className="btn btn-secondary" onClick={handleUpdate} disabled={noIssue || state.generating}>
              ↻ Update
            </button>
            <button className="btn btn-ghost" onClick={() => { state.openReview(); setShowReview(true) }}
              disabled={!state.output} style={{ marginLeft: 4 }}>
              📋 Review
            </button>
            <button className="btn btn-ghost" onClick={() => { (state as any).setOutput?.('') ?? null }}>
              Clear
            </button>

            {state.output && (
              <button className="btn btn-success" onClick={() => {
                state.openReview()
                setShowReview(true)
              }} style={{ marginLeft: 'auto' }}>
                ↑ Review & Upload to Zephyr
              </button>
            )}
          </div>

          {/* Generating indicator */}
          {state.generating && (
            <div style={{
              padding: '5px 14px', background: 'rgba(34,212,238,.04)',
              borderBottom: '1px solid rgba(34,212,238,.12)',
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 11, color: 'var(--cyan)', fontFamily: 'var(--mono)', flexShrink: 0,
            }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--cyan)', animation: 'blink .7s infinite' }} />
              {state.engine || 'Claude'} is generating…
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              padding: '8px 14px', background: 'rgba(224,85,85,.06)',
              borderBottom: '1px solid rgba(224,85,85,.2)',
              fontSize: 12, color: 'var(--red)', flexShrink: 0,
            }}>
              ✗ {error}
            </div>
          )}

          {/* Output */}
          <div ref={outputRef} style={{
            flex: 1, overflowY: 'auto', padding: '14px 18px',
            fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.75,
            whiteSpace: 'pre-wrap', color: 'var(--text)', background: '#fafaf8',
          }}>
            {!state.output && !state.generating && (
              <div style={{ color: 'var(--text3)', fontStyle: 'italic', fontFamily: 'var(--sans)', fontSize: 13 }}>
                {noIssue ? 'Select a ticket from the sidebar and click Generate Tests.' : 'Click Generate Tests to begin.'}
              </div>
            )}
            {state.output}
          </div>

          {/* Prompt bar */}
          <div style={{
            display: 'flex', gap: 7, padding: '8px 14px',
            borderTop: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0,
          }}>
            <input
              className="input" style={{ flex: 1, fontFamily: 'var(--sans)', fontSize: 12 }}
              placeholder="Custom prompt — leave blank for auto-generation"
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !state.generating) handleGenerate() }}
            />
            <button className="btn btn-secondary" onClick={handleGenerate} disabled={state.generating || noIssue}>
              Send
            </button>
          </div>
        </div>

        {/* Right: Zephyr panel */}
        <div style={{ width: 268, display: 'flex', flexDirection: 'column', background: 'var(--bg2)', flexShrink: 0 }}>
          <div style={{
            padding: '10px 12px', fontSize: 10, fontWeight: 700,
            letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)',
            borderBottom: '1px solid var(--border)',
          }}>
            Existing Zephyr Tests
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 7 }}>
            {!state.selectedIssue && (
              <div style={{ padding: 12, fontSize: 11, color: 'var(--text3)' }}>Select a ticket</div>
            )}
            {state.selectedIssue && allZephyr.length === 0 && (
              <div style={{ padding: 10, fontSize: 11, color: 'var(--amber)' }}>⚠ No tests — gap detected</div>
            )}
            {allZephyr.map((t, i) => (
              <div key={t.key ?? i} style={{
                padding: '8px 10px', borderRadius: 5,
                border: `1px solid ${t._new ? 'rgba(39,201,143,.4)' : 'var(--border)'}`,
                marginBottom: 5, background: 'var(--bg3)',
              }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: t._new ? 'var(--green)' : 'var(--green)',
                  marginBottom: 2, display: 'flex', gap: 5, alignItems: 'center',
                }}>
                  {t.key}
                  {t._new && <span className="chip chip-green" style={{ fontSize: 8 }}>NEW</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.35, marginBottom: 6 }}>
                  {t.name}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: 1, padding: '3px 0', fontSize: 10, justifyContent: 'center' }}
                    onClick={() => setViewTest(t)}
                  >
                    👁 View
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: 1, padding: '3px 0', fontSize: 10, justifyContent: 'center', color: 'var(--accent)' }}
                    onClick={() => {
                      setCustomPrompt(`Update test case ${t.key}: `)
                    }}
                  >
                    ✏ Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Review Modal */}
      {showReview && state.reviewCases.length > 0 && state.issueDetail && (
        <ReviewModal
          cases={state.reviewCases}
          issueKey={state.issueDetail.key}
          onClose={() => setShowReview(false)}
          onUpdate={state.updateReviewCase}
          onSendApproval={state.sendForApproval}
          onUploadApproved={state.uploadApproved}
          approvalStatus={state.approvalStatus}
          curApprovalId={state.curApprovalId}
        />
      )}

      {/* View test modal */}
      {viewTest && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setViewTest(null) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)',
            zIndex: 400, display: 'flex', alignItems: 'center',
            justifyContent: 'center', padding: 20, backdropFilter: 'blur(4px)',
          }}
        >
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, width: '100%', maxWidth: 660,
            maxHeight: 'calc(100vh - 40px)',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 24px 60px rgba(0,0,0,.5)',
          }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 3 }}>{viewTest.key}</div>
                <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{viewTest.name}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {viewTest.priority && <span className={chipPriority(viewTest.priority?.name)}>{viewTest.priority?.name}</span>}
                  {viewTest.status && <span className="chip" style={{ background: 'var(--bg4)', color: 'var(--text3)' }}>{viewTest.status.name}</span>}
                  {viewTest.folder && <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>📁 {viewTest.folder.name}</span>}
                </div>
              </div>
              <button onClick={() => setViewTest(null)} style={{ background: 'none', border: 'none', color: 'var(--text2)', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {viewTest.precondition && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)', marginBottom: 5 }}>Preconditions</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>{viewTest.precondition}</div>
                </div>
              )}
              {viewTest.steps && viewTest.steps.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)', marginBottom: 5 }}>Test Steps</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg4)' }}>
                        {['#','Action','Expected Result'].map(h => (
                          <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {viewTest.steps.map((s, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 10px', color: 'var(--text3)', textAlign: 'center' }}>{i + 1}</td>
                          <td style={{ padding: '6px 10px', color: 'var(--text2)', lineHeight: 1.5 }}>{s.description}</td>
                          <td style={{ padding: '6px 10px', color: 'var(--text2)', lineHeight: 1.5 }}>{s.expectedResult}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {viewTest.objective && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text3)', marginBottom: 5 }}>Objective</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', whiteSpace: 'pre-wrap', lineHeight: 1.65, background: 'var(--bg3)', padding: '8px 10px', borderRadius: 5, border: '1px solid var(--border)' }}>{viewTest.objective}</div>
                </div>
              )}
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => { setCustomPrompt(`Update test case ${viewTest.key}: `); setViewTest(null) }}>✏ Edit</button>
              <button className="btn btn-ghost" onClick={() => setViewTest(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

}
