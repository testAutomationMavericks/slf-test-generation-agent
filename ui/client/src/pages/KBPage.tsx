// ui/client/src/pages/KBPage.tsx
import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { KBStats } from '../types/api'

interface Props { kbStats: KBStats; onStatsChange: () => void }

export function KBPage({ kbStats, onStatsChange }: Props) {
  const [ids, setIds] = useState<string[]>([])
  const [importLog, setImportLog] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [scopeMode, setScopeMode] = useState<'project' | 'multi' | 'all'>('project')
  const [scopeProjects, setScopeProjects] = useState<string[]>([])
  const [availableProjects, setAvailableProjects] = useState<string[]>([])
  const [scopeSaved, setScopeSaved] = useState(false)

  useEffect(() => {
    loadList()
    api.getConfig().then(c => {
      setScopeMode(c.kbScopeMode ?? 'project')
      setScopeProjects(c.kbScopeProjects ?? [])
    }).catch(() => {})
    api.kbProjects().then(d => setAvailableProjects(d.projects)).catch(() => {})
  }, [])

  const loadList = async () => {
    try { setIds(await api.kbList()) } catch { /* ignore */ }
  }

  const handleClear = async () => {
    if (!confirm('Clear all KB documents?')) return
    await api.kbClear()
    setIds([])
    onStatsChange()
  }

  const handleImportZephyr = async () => {
    setShowImportModal(false)
    setImporting(true)
    setImportLog(['Starting Zephyr import…'])
    try {
      const res = await fetch('/api/kb/import/zephyr', { method: 'POST' })
      if (!res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        lines.filter(l => l.startsWith('data: ')).forEach(l => {
          try {
            const ev = JSON.parse(l.slice(6))
            setImportLog(prev => [...prev, ev.message])
          } catch { /* ignore */ }
        })
      }
    } catch (e) {
      setImportLog(prev => [...prev, 'Error: ' + String(e)])
    } finally {
      setImporting(false)
      await loadList()
      onStatsChange()
    }
  }

  const saveScope = async (mode: typeof scopeMode, projects: string[]) => {
    await api.setConfig({ kbScopeMode: mode, kbScopeProjects: projects })
    setScopeSaved(true)
    setTimeout(() => setScopeSaved(false), 2000)
  }

  const toggleScopeProject = (proj: string) => {
    const next = scopeProjects.includes(proj)
      ? scopeProjects.filter(p => p !== proj)
      : [...scopeProjects, proj]
    setScopeProjects(next)
    saveScope(scopeMode, next)
  }

  const handleScopeMode = (mode: typeof scopeMode) => {
    setScopeMode(mode)
    saveScope(mode, scopeProjects)
  }

  const SOURCE_COLORS: Record<string, string> = {
    generated: 'var(--accent)', jira: 'var(--amber)',
    confluence: 'var(--purple)', zephyr: 'var(--green)',
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 22px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)', display: 'flex', alignItems: 'center',
        gap: 10, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 14px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 600, color: 'var(--green)' }}>{kbStats.total}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em' }}>Documents</div>
        </div>
        {kbStats.lastUpdated && (
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 14px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
              {new Date(kbStats.lastUpdated).toLocaleDateString()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em' }}>Last Updated</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowImportModal(true)} disabled={importing}>
            {importing ? <span className="spinner" /> : '⬇'} Import from Zephyr
          </button>
          <button className="btn btn-secondary" onClick={loadList}>↻ Refresh</button>
          <button className="btn btn-danger" onClick={handleClear}>🗑 Clear</button>
        </div>
      </div>

      {/* Import log */}
      {importLog.length > 0 && (
        <div style={{
          padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
          color: 'var(--text3)', maxHeight: 80, overflowY: 'auto',
          borderBottom: '1px solid var(--border)', background: 'var(--bg)',
          flexShrink: 0,
        }}>
          {importLog.map((l, i) => (
            <div key={i} style={{ color: l.startsWith('✓') ? 'var(--green)' : l.startsWith('✗') || l.startsWith('Error') ? 'var(--red)' : 'var(--text3)' }}>{l}</div>
          ))}
        </div>
      )}

      {/* Retrieval Scope */}
      <div style={{
        padding: '12px 22px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Generation Scope
          </span>

          {/* Mode buttons */}
          {(['project', 'multi', 'all'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => handleScopeMode(mode)}
              style={{
                padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                border: '1px solid var(--border)', cursor: 'pointer',
                background: scopeMode === mode ? 'var(--accent)' : 'var(--bg3)',
                color: scopeMode === mode ? '#fff' : 'var(--text2)',
              }}
            >
              {mode === 'project' ? 'This project' : mode === 'multi' ? 'Select projects' : 'All projects'}
            </button>
          ))}

          {scopeSaved && (
            <span style={{ fontSize: 11, color: 'var(--green)' }}>✓ Saved</span>
          )}
        </div>

        {/* Project checkboxes (multi mode only) */}
        {scopeMode === 'multi' && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {availableProjects.length === 0 ? (
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>No projects found in KB yet.</span>
            ) : availableProjects.map(proj => (
              <label key={proj} style={{
                display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                padding: '3px 10px', borderRadius: 5, fontSize: 11,
                border: '1px solid var(--border)',
                background: scopeProjects.includes(proj) ? 'var(--accent)18' : 'var(--bg3)',
                color: scopeProjects.includes(proj) ? 'var(--accent)' : 'var(--text2)',
              }}>
                <input
                  type="checkbox"
                  checked={scopeProjects.includes(proj)}
                  onChange={() => toggleScopeProject(proj)}
                  style={{ accentColor: 'var(--accent)', margin: 0 }}
                />
                {proj}
              </label>
            ))}
          </div>
        )}

        {scopeMode !== 'project' && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text3)' }}>
            {scopeMode === 'multi'
              ? `Retrieval covers ${scopeProjects.length ? scopeProjects.join(', ') : 'no projects selected'}`
              : 'Retrieval covers all projects — best for regression suites'}
          </div>
        )}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px' }}>
        {ids.length === 0 && (
          <div style={{ color: 'var(--text3)', fontSize: 12 }}>Empty — click Re-seed to populate.</div>
        )}
        {ids.map(id => {
          const src = id.split(':')[0] ?? 'unknown'
          return (
            <div key={id} style={{
              display: 'flex', alignItems: 'center', padding: '6px 10px',
              borderRadius: 5, border: '1px solid var(--border)',
              marginBottom: 3, background: 'var(--bg2)',
              fontFamily: 'var(--mono)', fontSize: 11, gap: 9,
            }}>
              <span style={{
                padding: '1px 5px', borderRadius: 2, fontSize: 9,
                fontWeight: 700, textTransform: 'uppercase',
                background: `${SOURCE_COLORS[src] ?? 'var(--text3)'}20`,
                color: SOURCE_COLORS[src] ?? 'var(--text3)',
              }}>{src}</span>
              <span style={{ color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</span>
            </div>
          )
        })}
      </div>

      {/* Zephyr import confirmation modal */}
      {showImportModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '28px 32px', maxWidth: 460, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Import from Zephyr</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 16 }}>
              This will fetch <strong>all test cases</strong> for the configured project from Zephyr Scale
              and add them to the Knowledge Base.
            </div>
            <div style={{
              background: 'var(--bg3)', border: '1px solid var(--amber)33',
              borderRadius: 6, padding: '10px 14px', marginBottom: 20,
              fontSize: 12, color: 'var(--amber)', lineHeight: 1.6,
            }}>
              <strong>Safe to run more than once</strong> — test cases already in the KB
              (matched by Zephyr key) are automatically skipped. No duplicates will be created.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowImportModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleImportZephyr}>
                Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
