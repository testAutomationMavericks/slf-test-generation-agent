// ui/client/src/components/Sidebar.tsx
import { useState } from 'react'
import type { JiraIssue } from '../types/api'

interface Props {
  issues: JiraIssue[]
  selectedIssue: JiraIssue | null
  connecting: boolean
  kbTotal: number
  onSelect: (issue: JiraIssue) => void
  onRefresh: () => void
  onReconnect: () => void
}

export function Sidebar({ issues, selectedIssue, connecting, kbTotal, onSelect, onRefresh, onReconnect }: Props) {
  const [filter, setFilter] = useState('')

  const filtered = filter
    ? issues.filter(i =>
        i.key.toLowerCase().includes(filter.toLowerCase()) ||
        i.summary.toLowerCase().includes(filter.toLowerCase())
      )
    : issues

  return (
    <aside style={{
      width: 260,
      background: '#f4f3f0',
      borderRight: '1px solid #c8c7c0',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid #c8c7c0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700,
          letterSpacing: '.18em', textTransform: 'uppercase',
          color: '#555', fontFamily: 'var(--sans)',
        }}>
          Jira Issues
        </span>
        <button
          style={{
            background: 'none', border: '1px solid #c8c7c0',
            padding: '3px 8px', cursor: 'pointer',
            fontSize: 14, color: '#333', borderRadius: 0,
          }}
          onClick={onRefresh}
          disabled={connecting}
        >
          {connecting ? '…' : '↻'}
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #d0cfc8' }}>
        <input
          style={{
            width: '100%', background: '#fff',
            border: '1px solid #c8c7c0', borderRadius: 0,
            padding: '8px 11px', color: '#111',
            fontFamily: 'var(--mono)', fontSize: 13, outline: 'none',
          }}
          placeholder="Filter issues…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {connecting && (
          <div style={{ padding: '18px 16px', fontSize: 13, color: '#666' }}>
            Connecting…
          </div>
        )}

        {!connecting && filtered.length === 0 && (
          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {issues.length === 0 ? 'No issues loaded.' : 'No matches.'}
            </p>
            {issues.length === 0 && (
              <button
                style={{
                  width: '100%', background: 'transparent',
                  border: '1px solid #c8c7c0', padding: '8px 0',
                  cursor: 'pointer', fontSize: 11, color: '#333',
                  letterSpacing: '.1em', textTransform: 'uppercase',
                }}
                onClick={onReconnect}
              >
                Retry Connection
              </button>
            )}
          </div>
        )}

        {filtered.map(issue => {
          const p = (issue.priority?.name ?? 'medium').toLowerCase()
          const active = selectedIssue?.key === issue.key

          // Priority chip colour
          const prioColor = p === 'critical' ? '#7a1010'
            : p === 'high' ? '#7a1010'
            : p === 'medium' ? '#7a4800'
            : '#555'
          const prioBorder = p === 'critical' || p === 'high' ? 'rgba(122,16,16,.3)'
            : p === 'medium' ? 'rgba(122,72,0,.3)'
            : '#ccc'

          return (
            <div
              key={issue.key}
              onClick={() => onSelect(issue)}
              style={{
                padding: '12px 14px',
                cursor: 'pointer',
                borderLeft: `3px solid ${active ? '#888' : 'transparent'}`,
                borderBottom: '1px solid #d8d7d0',
                background: active ? '#dddbd4' : 'transparent',
                transition: 'background .12s',
              }}
              onMouseEnter={e => {
                if (!active)(e.currentTarget as HTMLDivElement).style.background = '#e8e6e0'
              }}
              onMouseLeave={e => {
                if (!active)(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              {/* Key */}
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: '#8a5a00', letterSpacing: '.06em',
                marginBottom: 5, textTransform: 'uppercase',
              }}>
                {issue.key}
              </div>

              {/* Summary */}
              <div style={{
                fontSize: 14, fontWeight: 400,
                color: '#111',
                lineHeight: 1.4,
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                marginBottom: 7,
              }}>
                {issue.summary}
              </div>

              {/* Chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{
                  padding: '2px 8px', fontSize: 11,
                  fontFamily: 'var(--mono)', fontWeight: 600,
                  border: `1px solid ${prioBorder}`,
                  color: prioColor, background: 'transparent',
                  textTransform: 'uppercase', letterSpacing: '.06em',
                }}>
                  {issue.priority?.name ?? 'Medium'}
                </span>
                {issue.status && (
                  <span style={{
                    padding: '2px 8px', fontSize: 11,
                    fontFamily: 'var(--mono)', fontWeight: 400,
                    border: '1px solid #c0bfb8',
                    color: '#444', background: 'transparent',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                  }}>
                    {issue.status.name}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 16px',
        borderTop: '1px solid #c8c7c0',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 10, color: '#888', letterSpacing: '.16em', textTransform: 'uppercase', fontWeight: 600 }}>
          Knowledge Base
        </span>
        <span style={{ fontFamily: 'var(--mono)', color: '#1a6040', fontSize: 14, fontWeight: 500, marginLeft: 'auto' }}>
          {kbTotal}
        </span>
        <span style={{ fontSize: 10, color: '#888', letterSpacing: '.12em', textTransform: 'uppercase' }}>
          docs
        </span>
      </div>
    </aside>
  )
}
