// ui/client/src/pages/KBPage.tsx
import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { KBStats } from '../types/api'

interface Props { kbStats: KBStats; onStatsChange: () => void }

export function KBPage({ kbStats, onStatsChange }: Props) {
  const [ids, setIds] = useState<string[]>([])
  const [seedLog, setSeedLog] = useState<string[]>([])
  const [seeding, setSeeding] = useState(false)
  const [importLog, setImportLog] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)

  useEffect(() => { loadList() }, [])

  const loadList = async () => {
    try { setIds(await api.kbList()) } catch { /* ignore */ }
  }

  const handleSeed = async () => {
    setSeeding(true)
    setSeedLog(['Starting seed…'])
    try {
      await api.kbClear()
      const child = await fetch('/api/kb/seed', { method: 'POST' })
      if (!child.body) return
      const reader = child.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        buf.split('\n').filter(l => l.startsWith('data: ')).forEach(l => {
          try {
            const ev = JSON.parse(l.slice(6))
            setSeedLog(prev => [...prev, ev.message])
          } catch { /* ignore */ }
        })
        buf = buf.includes('\n') ? buf.split('\n').pop() ?? '' : buf
      }
    } catch (e) {
      setSeedLog(prev => [...prev, 'Error: ' + String(e)])
    } finally {
      setSeeding(false)
      await loadList()
      onStatsChange()
    }
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
          <button className="btn btn-primary" onClick={handleSeed} disabled={seeding}>
            {seeding ? <span className="spinner" /> : '🌱'} Re-seed
          </button>
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

      {/* Seed log */}
      {seedLog.length > 0 && (
        <div style={{
          padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
          color: 'var(--text3)', maxHeight: 80, overflowY: 'auto',
          borderBottom: '1px solid var(--border)', background: 'var(--bg)',
          flexShrink: 0,
        }}>
          {seedLog.map((l, i) => (
            <div key={i} style={{ color: l.includes('✓') || l.includes('complete') ? 'var(--green)' : l.includes('Error') ? 'var(--red)' : 'var(--text3)' }}>{l}</div>
          ))}
        </div>
      )}

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
