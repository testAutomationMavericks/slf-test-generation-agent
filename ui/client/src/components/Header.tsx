// ui/client/src/components/Header.tsx
import type { Page } from '../App'
import type { ServerStatus } from '../types/api'

interface Props {
  status: ServerStatus | null
  page: Page
  onNav: (p: Page) => void
}

const PROVIDER_LABELS: Record<string, string> = {
  claudecode: 'Claude Code',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  local: 'Local',
}

const NAV_ITEMS: Array<{ id: Page; label: string }> = [
  { id: 'console',   label: 'Console'        },
  { id: 'kb',        label: 'Knowledge Base' },
  { id: 'approvals', label: 'Approvals'      },
  { id: 'config',    label: 'Config'         },
]

export function Header({ status, page, onNav }: Props) {
  const connected = status !== null && status !== undefined
  const provider  = status?.aiProvider ?? 'claudecode'

  return (
    <header style={{
      background: '#000',
      height: 54,
      display: 'flex',
      alignItems: 'stretch',
      padding: '0 0 0 24px',
      borderBottom: '1px solid #1a1a1a',
      flexShrink: 0,
      position: 'relative',
    }}>
      {/* Yellow accent stripe — bottom left, matches selfridges.com */}
      <div style={{
        position: 'absolute',
        bottom: 0, left: 0,
        width: '100%',
        height: '2px',
        background: 'linear-gradient(90deg, #f0c040 0%, #f0c040 160px, transparent 160px)',
        pointerEvents: 'none',
      }} />

      {/* Wordmark — Selfridges typographic style */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        marginRight: 36,
        paddingRight: 24,
        borderRight: '1px solid #1c1c1c',
        flexShrink: 0,
      }}>
        <div style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '.24em',
          color: '#fff',
          lineHeight: 1,
          textTransform: 'uppercase',
        }}>
          Selfridges
        </div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '.32em',
          color: '#f0c040',
          textTransform: 'uppercase',
          marginTop: 4,
        }}>
          Test Management
        </div>
      </div>

      {/* Navigation — uppercase, tracking, Selfridges style */}
      <nav style={{ display: 'flex', alignItems: 'stretch' }}>
        {NAV_ITEMS.map(item => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              onClick={() => onNav(item.id)}
              style={{
                height: '100%',
                padding: '0 22px',
                border: 'none',
                borderBottom: active ? '2px solid #f0c040' : '2px solid transparent',
                background: 'transparent',
                color: active ? '#fff' : '#666',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '.18em',
                textTransform: 'uppercase',
                cursor: 'pointer',
                transition: 'color .15s',
                marginBottom: '-1px',
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#bbb' }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#666' }}
            >
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* Right status strip */}
      <div style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        paddingRight: 24,
        borderLeft: '1px solid #1c1c1c',
        paddingLeft: 24,
      }}>
        {/* Connection indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 20 }}>
          <div style={{
            width: 5, height: 5,
            background: connected ? '#3d9970' : '#666',
            boxShadow: connected ? '0 0 5px #3d9970' : 'none',
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 11, fontWeight: 600,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: connected ? '#3d9970' : '#888',
          }}>
            {connected ? 'Connected' : status ? 'Offline' : '…'}
          </span>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 18, background: '#222', marginRight: 20 }} />

        {/* KB backend badge — PG (green = connected, gray = not configured) */}
        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: connected ? '#3d9970' : '#999',
          border: `1px solid ${connected ? 'rgba(61,153,112,.4)' : '#555'}`,
          padding: '3px 8px', marginRight: 10,
        }}>
          KB:PG
        </span>

        {/* Provider badge — yellow */}
        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
          textTransform: 'uppercase', color: '#f0c040',
          border: '1px solid rgba(240,192,64,.3)',
          padding: '3px 8px', background: 'rgba(240,192,64,.04)',
        }}>
          {PROVIDER_LABELS[provider] ?? provider}
        </span>
      </div>
    </header>
  )
}
