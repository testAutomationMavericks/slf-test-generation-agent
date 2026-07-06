// ui/client/src/App.tsx
import { useState, useEffect } from 'react'
import { useAppState } from './hooks/useAppState'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'
import { ConsolePage } from './pages/ConsolePage'
import { KBPage } from './pages/KBPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { ConfigPage } from './pages/ConfigPage'
import './index.css'

export type Page = 'console' | 'kb' | 'approvals' | 'config'

export default function App() {
  const [page, setPage] = useState<Page>('console')
  const state = useAppState()

  useEffect(() => {
    state.loadStatus()
    state.loadIssues()
    // Refresh service statuses every 30 s so the header stays current
    const interval = setInterval(state.loadStatus, 30_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header
        status={state.status}
        page={page}
        onNav={setPage}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {page === 'console' && (
          <Sidebar
            issues={state.issues}
            selectedIssue={state.selectedIssue}
            connecting={state.connecting}
            kbTotal={state.kbStats.total}
            onSelect={state.selectIssue}
            onRefresh={state.loadIssues}
            onReconnect={state.reconnect}
          />
        )}
        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {page === 'console' && <ConsolePage state={state} />}
          {page === 'kb' && <KBPage kbStats={state.kbStats} onStatsChange={state.loadKBStats} />}
          {page === 'approvals' && <ApprovalsPage onNav={setPage} />}
          {page === 'config' && <ConfigPage onSaved={state.loadStatus} />}
        </main>
      </div>
    </div>
  )
}
