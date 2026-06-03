// ui/client/src/pages/ConfigPage.tsx
import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { UIConfig, AIProvider, AppMode, KBBackend } from '../types/api'

interface Props { onSaved: () => void }

const PROVIDERS: Array<{ id: AIProvider; label: string }> = [
  { id: 'claudecode', label: '⚡ Claude Code' },
  { id: 'anthropic',  label: '🟣 Anthropic API' },
  { id: 'openai',     label: '🟢 OpenAI' },
  { id: 'local',      label: '🖥 Local Model' },
]

// ── Shared styles ──────────────────────────────────────────────────────────────
const S = {
  section: { marginBottom: 28 } as const,
  label: { fontSize: 10, fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase' as const, color: '#666', fontFamily: 'var(--sans)', marginBottom: 10 },
  divider: { height: 1, background: '#d8d7d0', margin: '24px 0' } as const,
  note: (color: string, bg: string) => ({
    border: `1px solid ${color}`, background: bg,
    borderRadius: 0, padding: '10px 14px',
    fontSize: 13, color: '#333', lineHeight: 1.65, marginBottom: 14,
  }),
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 } as const,
  field: { display: 'flex', flexDirection: 'column' as const, gap: 5 },
  fieldLabel: { fontSize: 11, color: '#444', fontWeight: 600, fontFamily: 'var(--sans)' },
}

// ── Toggle group ───────────────────────────────────────────────────────────────
function ToggleGroup<T extends string>({ options, value, onChange, colors }: {
  options: Array<{ id: T; label: string }>
  value: T
  onChange: (v: T) => void
  colors?: Partial<Record<T, string>>
}) {
  return (
    <div style={{
      display: 'flex', gap: 2, background: '#ebe9e3',
      padding: 3, border: '1px solid #c8c7c0', width: 'fit-content',
    }}>
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{
          padding: '6px 16px', border: 'none', background: value === o.id ? '#111' : 'transparent',
          color: value === o.id ? (colors?.[o.id] ?? '#fff') : '#555',
          fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 600,
          letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer',
          transition: 'all .15s',
        }}>{o.label}</button>
      ))}
    </div>
  )
}

// ── Field helpers ──────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={S.field}>
      <label style={S.fieldLabel}>{label}</label>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <input className="input" type={type} placeholder={placeholder}
      value={value} onChange={e => onChange(e.target.value)} />
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select className="input" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function TestBtn({ label, onTest }: { label: string; onTest: () => Promise<{ ok: boolean; detail?: string; error?: string }> }) {
  const [state, setState] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const run = async () => {
    setLoading(true); setState(null)
    try { setState(await onTest()) } catch (e: unknown) { setState({ ok: false, error: String(e) }) }
    finally { setLoading(false) }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="btn btn-secondary" onClick={run} disabled={loading} style={{ fontSize: 11, padding: '5px 12px' }}>
        {loading ? <span className="spinner" /> : '⚡'} {label}
      </button>
      {state && (
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: state.ok ? 'var(--green)' : 'var(--red)' }}>
          {state.ok ? `✓ ${state.detail ?? 'OK'}` : `✗ ${state.error}`}
        </span>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export function ConfigPage({ onSaved }: Props) {
  const [cfg, setCfg] = useState<Partial<UIConfig>>({})
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [ccStatus, setCcStatus] = useState<{ available: boolean; version?: string } | null>(null)

  useEffect(() => {
    api.getConfig().then(c => setCfg(c)).catch(() => {})
    api.checkClaudeCode().then(r => setCcStatus(r)).catch(() => {})
  }, [])

  const set = (k: keyof UIConfig, v: string | boolean) => setCfg(p => ({ ...p, [k]: v }))

  const mode = (cfg.mode ?? 'mock') as AppMode
  const kbBackend = (cfg.kbBackend ?? 'local') as KBBackend
  const provider = (cfg.aiProvider ?? 'claudecode') as AIProvider

  const save = async () => {
    await api.setConfig(cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    onSaved()
  }

  const testConn = async () => {
    setTesting(true)
    try { await save(); await api.connect(); alert('✓ Connected successfully!') }
    catch (e: unknown) { alert('Failed: ' + (e instanceof Error ? e.message : String(e))) }
    finally { setTesting(false) }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
        <div style={{ maxWidth: 700 }}>

          {/* ── Section 1: Data Source ─────────────────────────────────────── */}
          <div style={S.section}>
            <div style={S.label}>🔌 Data Source Mode</div>
            <ToggleGroup
              options={[
                { id: 'mock' as AppMode, label: 'Mock (Local)' },
                { id: 'live' as AppMode, label: 'Live (Atlassian)' },
              ]}
              value={mode}
              onChange={v => set('mode', v)}
              colors={{ live: '#3d9970' }}
            />
            <div style={{ marginTop: 12, ...S.note(
              mode === 'mock' ? 'rgba(100,80,160,.3)' : 'rgba(61,153,112,.3)',
              mode === 'mock' ? 'rgba(100,80,160,.04)' : 'rgba(61,153,112,.04)',
            )}}>
              {mode === 'mock'
                ? '🟣 Mock mode — Jira, Confluence, and Zephyr use local demo data (DEMO-1 to DEMO-4). No credentials needed.'
                : '🟢 Live mode — Connects to your real Atlassian and Zephyr Scale instances. Fill in credentials below.'}
            </div>
          </div>

          <div style={S.divider} />

          {/* ── Section 2: KB Backend ──────────────────────────────────────── */}
          <div style={S.section}>
            <div style={S.label}>🗄 Knowledge Base Storage</div>
            <ToggleGroup
              options={[
                { id: 'local' as KBBackend, label: 'Phase 1 — Local JSON' },
                { id: 'pgvector' as KBBackend, label: 'Phase 2 — pgvector' },
              ]}
              value={kbBackend}
              onChange={v => set('kbBackend', v)}
              colors={{ pgvector: '#3d9970' }}
            />
            <div style={{ marginTop: 12, ...S.note(
              kbBackend === 'local' ? 'rgba(100,80,160,.3)' : 'rgba(61,153,112,.3)',
              kbBackend === 'local' ? 'rgba(100,80,160,.04)' : 'rgba(61,153,112,.04)',
            )}}>
              {kbBackend === 'local'
                ? '📁 Local JSON — stored in local-kb-data/index.json on this machine. Works offline, no setup needed. Best for single-user or demo use.'
                : '🐘 pgvector — PostgreSQL + voyage-3 embeddings. Shared across the whole team, true semantic search, scales to millions of docs.'}
            </div>

            {kbBackend === 'pgvector' && (
              <div style={{ marginTop: 12 }}>
                <div style={S.note('rgba(200,148,26,.35)', 'rgba(200,148,26,.04)')}>
                  <strong>Requires:</strong> PostgreSQL with pgvector extension + Anthropic API key for voyage-3 embeddings.{' '}
                  Run <code style={{ fontFamily: 'var(--mono)', background: '#f0efe9', padding: '1px 5px', fontSize: 12 }}>npm install postgres</code>{' '}
                  and apply <code style={{ fontFamily: 'var(--mono)', background: '#f0efe9', padding: '1px 5px', fontSize: 12 }}>src/kb/schema.sql</code> to your database first.
                </div>
                <Field label="Database URL">
                  <TextInput
                    value={String(cfg.databaseUrl ?? '')}
                    onChange={v => set('databaseUrl', v)}
                    placeholder="postgresql://user:password@host:5432/dbname"
                    type="password"
                  />
                </Field>
                <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
                  After switching, run <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>npm run kb:migrate</code> to copy existing documents from local JSON to pgvector.
                </div>
              </div>
            )}
          </div>

          <div style={S.divider} />

          {/* ── Section 3: AI Provider ────────────────────────────────────── */}
          <div style={S.section}>
            <div style={S.label}>🤖 AI Provider</div>
            <div style={{
              display: 'flex', gap: 2, background: '#ebe9e3',
              padding: 3, border: '1px solid #c8c7c0',
              marginBottom: 14, flexWrap: 'wrap' as const,
            }}>
              {PROVIDERS.map(p => (
                <button key={p.id} onClick={() => set('aiProvider', p.id)} style={{
                  padding: '6px 14px', border: 'none',
                  background: provider === p.id ? '#111' : 'transparent',
                  color: provider === p.id ? '#fff' : '#555',
                  fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 600,
                  letterSpacing: '.1em', textTransform: 'uppercase' as const, cursor: 'pointer',
                }}>{p.label}</button>
              ))}
            </div>

            {provider === 'claudecode' && (
              <>
                <div style={S.note('rgba(200,148,26,.35)', 'rgba(200,148,26,.04)')}>
                  Uses your installed Claude Code binary. No API key needed — billed via your Claude subscription.
                </div>
                <div style={{
                  background: '#f4f3f0', border: '1px solid #d0cfc8',
                  padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12,
                  color: ccStatus?.available ? '#2a7a50' : '#7a1010',
                }}>
                  {ccStatus === null ? 'Checking…'
                    : ccStatus?.available ? `✓ Claude Code ${ccStatus.version} — ready`
                    : '✗ Not found — run: npm install -g @anthropic-ai/claude-code'}
                </div>
              </>
            )}

            {provider === 'anthropic' && (
              <>
                <div style={S.note('rgba(100,80,160,.3)', 'rgba(100,80,160,.04)')}>
                  Direct Anthropic API. Includes prompt caching (90% cheaper on repeated context).
                  Also required for voyage-3 embeddings in pgvector mode.
                </div>
                <div style={S.row}>
                  <Field label="API Key">
                    <TextInput value={String(cfg.anthropicApiKey ?? '')} onChange={v => set('anthropicApiKey', v)} placeholder="sk-ant-api03-…" type="password" />
                  </Field>
                  <Field label="Model">
                    <SelectInput value={String(cfg.claudeModel ?? 'claude-sonnet-4-20250514')} onChange={v => set('claudeModel', v)} options={[
                      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 — recommended' },
                      { value: 'claude-opus-4-20250514', label: 'Claude Opus 4 — most powerful' },
                      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fastest' },
                    ]} />
                  </Field>
                </div>
              </>
            )}

            {provider === 'openai' && (
              <>
                <div style={S.note('rgba(61,153,112,.3)', 'rgba(61,153,112,.04)')}>
                  OpenAI API — GPT-4o, o3, and other OpenAI models.
                </div>
                <div style={S.row}>
                  <Field label="OpenAI API Key">
                    <TextInput value={String(cfg.openaiApiKey ?? '')} onChange={v => set('openaiApiKey', v)} placeholder="sk-…" type="password" />
                  </Field>
                  <Field label="Model">
                    <SelectInput value={String(cfg.openaiModel ?? 'gpt-4o')} onChange={v => set('openaiModel', v)} options={[
                      { value: 'gpt-4o', label: 'GPT-4o — recommended' },
                      { value: 'gpt-4o-mini', label: 'GPT-4o Mini — faster' },
                      { value: 'o3', label: 'o3 — reasoning' },
                    ]} />
                  </Field>
                </div>
              </>
            )}

            {provider === 'local' && (
              <>
                <div style={S.note('rgba(200,148,26,.35)', 'rgba(200,148,26,.04)')}>
                  Ollama, LM Studio, or any OpenAI-compatible endpoint.
                </div>
                <div style={{ ...S.row, gridTemplateColumns: '2fr 1fr' }}>
                  <Field label="Base URL">
                    <TextInput value={String(cfg.localBaseUrl ?? '')} onChange={v => set('localBaseUrl', v)} placeholder="http://localhost:11434/v1" />
                  </Field>
                  <Field label="Model">
                    <TextInput value={String(cfg.localModel ?? '')} onChange={v => set('localModel', v)} placeholder="llama3.2" />
                  </Field>
                </div>
                <Field label="API Key (optional)">
                  <TextInput value={String(cfg.localApiKey ?? '')} onChange={v => set('localApiKey', v)} placeholder="Leave blank for Ollama" type="password" />
                </Field>
              </>
            )}
          </div>

          {/* ── Section 4: Live Atlassian credentials ────────────────────── */}
          {mode === 'live' && (
            <>
              <div style={S.divider} />
              <div style={S.section}>
                <div style={S.label}>🟡 Jira + Confluence</div>

                <div style={S.note('rgba(100,80,160,.3)', 'rgba(100,80,160,.04)')}>
                  <strong>Bearer token</strong> (OAuth / PAT) — paste your token below and leave Username + API Token blank.<br />
                  <strong>Basic auth</strong> — leave Bearer Token blank and fill in Username + API Token.
                </div>

                <div style={S.row}>
                  <Field label="Jira URL">
                    <TextInput value={String(cfg.jiraUrl ?? '')} onChange={v => set('jiraUrl', v)} placeholder="https://api.atlassian.com/ex/jira/{cloudId}" />
                  </Field>
                  <Field label="Project Key">
                    <TextInput value={String(cfg.jiraProjectKey ?? '')} onChange={v => set('jiraProjectKey', v)} placeholder="e.g. SLF or DEMO" />
                  </Field>
                </div>

                <div style={S.row}>
                  <Field label="Bearer Token (OAuth / PAT)">
                    <TextInput value={String(cfg.jiraBearerToken ?? '')} onChange={v => set('jiraBearerToken', v)} placeholder="Leave blank to use Basic Auth below" type="password" />
                  </Field>
                  <div />
                </div>

                <div style={S.row}>
                  <Field label="Username / Email (Basic Auth only)">
                    <TextInput value={String(cfg.jiraUsername ?? '')} onChange={v => set('jiraUsername', v)} placeholder="you@selfridges.com — not needed with Bearer" />
                  </Field>
                  <Field label="Jira API Token (Basic Auth only)">
                    <TextInput value={String(cfg.jiraApiToken ?? '')} onChange={v => set('jiraApiToken', v)} placeholder="Not needed with Bearer Token" type="password" />
                  </Field>
                </div>

                <div style={S.row}>
                  <Field label="Confluence URL">
                    <TextInput value={String(cfg.confluenceUrl ?? '')} onChange={v => set('confluenceUrl', v)} placeholder="https://your-company.atlassian.net/wiki" />
                  </Field>
                  <Field label="Confluence API Token (Basic Auth only)">
                    <TextInput value={String(cfg.confluenceApiToken ?? '')} onChange={v => set('confluenceApiToken', v)} placeholder="Same token as Jira on Atlassian Cloud" type="password" />
                  </Field>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <TestBtn label="Test Jira" onTest={() => api.testJira()} />
                  <TestBtn label="Test Confluence" onTest={() => api.testConfluence()} />
                </div>

                <div style={{ marginTop: 20, marginBottom: 10 }}>
                  <div style={S.label}>🟢 Zephyr Scale</div>
                </div>
                <div style={S.row}>
                  <Field label="Zephyr API Token">
                    <TextInput value={String(cfg.zephyrApiToken ?? '')} onChange={v => set('zephyrApiToken', v)} placeholder="Zephyr Scale → Settings → API Tokens" type="password" />
                  </Field>
                  <Field label="Zephyr Base URL">
                    <TextInput value={String(cfg.zephyrBaseUrl ?? '')} onChange={v => set('zephyrBaseUrl', v)} placeholder="https://api.zephyrscale.smartbear.com/v2" />
                  </Field>
                </div>
                <div style={{ marginTop: 4 }}>
                  <TestBtn label="Test Zephyr" onTest={() => api.testZephyr()} />
                </div>
              </div>
            </>
          )}

        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 32px', borderTop: '1px solid #d0cfc8',
        background: '#f4f3f0', display: 'flex', gap: 10, alignItems: 'center',
      }}>
        <button className="btn btn-primary" onClick={save}>Save & Apply</button>
        <button className="btn btn-secondary" onClick={testConn} disabled={testing}>
          {testing ? <span className="spinner" /> : null} Test Connection
        </button>
        {kbBackend === 'pgvector' && (
          <button className="btn btn-secondary" onClick={() => {
            alert('Run in terminal:\nnpm run kb:migrate\n\nThis copies your local KB documents to pgvector with voyage-3 embeddings.')
          }}>
            ↑ Migrate Local → pgvector
          </button>
        )}
        {saved && (
          <span style={{ fontSize: 12, color: '#2a7a50', fontWeight: 600 }}>✓ Saved</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: '#888' }}>
          <span>Jira/Zephyr: <strong style={{ color: mode === 'live' ? '#2a7a50' : '#7a5fa0' }}>{mode}</strong></span>
          <span>•</span>
          <span>KB: <strong style={{ color: kbBackend === 'pgvector' ? '#2a7a50' : '#7a5fa0' }}>{kbBackend}</strong></span>
          <span>•</span>
          <span>AI: <strong style={{ color: '#111' }}>{provider}</strong></span>
        </div>
      </div>
    </div>
  )
}
