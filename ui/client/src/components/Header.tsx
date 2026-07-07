// ui/client/src/components/Header.tsx
import type { Page } from '../App'
import type { ServerStatus, ServiceStatuses } from '../types/api'

interface Props {
  status: ServerStatus | null
  page: Page
  onNav: (p: Page) => void
}

const PROVIDER_LABELS: Record<string, string> = {
  claudecode: 'Claude Code',
  anthropic:  'Anthropic API',
  openai:     'OpenAI',
  local:      'Local',
}

const NAV_ITEMS: Array<{ id: Page; label: string }> = [
  { id: 'console',   label: 'Console'        },
  { id: 'kb',        label: 'Knowledge Base' },
  { id: 'approvals', label: 'Approvals'      },
  { id: 'config',    label: 'Config'         },
]

const SERVICE_LABELS: Array<{ key: keyof ServiceStatuses; label: string; providerLabel?: boolean }> = [
  { key: 'jira',       label: 'Jira'           },
  { key: 'confluence', label: 'Confluence'      },
  { key: 'zephyr',     label: 'Zephyr'          },
  { key: 'db',         label: 'Knowledge Base'  },
  { key: 'ai',         label: 'AI',             providerLabel: true },
]

export function Header({ status, page, onNav }: Props) {
  const loading  = status === null
  const provider = status?.aiProvider ?? 'claudecode'
  const svc      = status?.services ?? { jira: false, confluence: false, zephyr: false, db: false, ai: false }

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
      {/* Yellow accent stripe */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0,
        width: '100%', height: '2px', pointerEvents: 'none',
        background: 'linear-gradient(90deg, #f0c040 0%, #f0c040 160px, transparent 160px)',
      }} />

      {/* Wordmark */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        marginRight: 36, paddingRight: 24,
        borderRight: '1px solid #1c1c1c', flexShrink: 0,
      }}>
        <div style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 22, fontWeight: 600, letterSpacing: '.24em',
          color: '#fff', lineHeight: 1, textTransform: 'uppercase',
        }}>Selfridges</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 11, fontWeight: 600, letterSpacing: '.28em',
          color: '#f0c040', textTransform: 'uppercase', marginTop: 4,
        }}>Test Curator</div>
      </div>

      {/* Navigation */}
      <nav style={{ display: 'flex', alignItems: 'stretch' }}>
        {NAV_ITEMS.map(item => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              onClick={() => onNav(item.id)}
              style={{
                height: '100%', padding: '0 22px', border: 'none',
                borderBottom: active ? '2px solid #f0c040' : '2px solid transparent',
                background: 'transparent',
                color: active ? '#fff' : '#666',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 11, fontWeight: 600, letterSpacing: '.18em',
                textTransform: 'uppercase', cursor: 'pointer',
                transition: 'color .15s', marginBottom: '-1px',
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#bbb' }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = '#666' }}
            >
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* ── Service status bar ── separated from nav by left border ── */}
      <div style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 20,
        paddingRight: 20,
        borderLeft: '1px solid #1c1c1c',
        gap: 8,
      }}>

        {/* Service status chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {SERVICE_LABELS.map(({ key, label, providerLabel }) => {
            const on      = !loading && svc[key]
            const unknown = loading
            const chipLabel = providerLabel
              ? `${label}: ${unknown ? '…' : (PROVIDER_LABELS[provider] ?? provider)}`
              : label
            const title = unknown
              ? `${label}: loading…`
              : on ? `${label}: ready` : `${label}: not configured`
            return (
              <span
                key={key}
                title={title}
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 9, fontWeight: 600,
                  letterSpacing: '.1em', textTransform: 'uppercase',
                  padding: '4px 9px',
                  border: `1px solid ${unknown ? '#2a2a2a' : on ? 'rgba(61,153,112,.45)' : 'rgba(120,40,40,.5)'}`,
                  background: unknown ? 'transparent' : on ? 'rgba(61,153,112,.1)' : 'rgba(120,40,40,.08)',
                  color: unknown ? '#333' : on ? '#3d9970' : '#7a3030',
                  whiteSpace: 'nowrap',
                  transition: 'all .3s',
                }}
              >
                {chipLabel}
              </span>
            )
          })}
        </div>
      </div>
    </header>
  )
}
