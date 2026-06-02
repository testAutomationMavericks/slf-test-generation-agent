// ui/client/src/pages/KBPage.tsx
import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { KBStats } from '../types/api'

interface Props { kbStats: KBStats; onStatsChange: () => void }

export function KBPage({ kbStats, onStatsChange }: Props) {
  const [ids, setIds] = useState<string[]>([])
  const [seedLog, setSeedLog] = useState<string[]>([])
  const [seeding, setSeeding] = useState(false)

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
          <button className="btn btn-secondary" onClick={loadList}>↻ Refresh</button>
          <button className="btn btn-danger" onClick={handleClear}>🗑 Clear</button>
        </div>
      </div>

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
    </div>
  )
}
