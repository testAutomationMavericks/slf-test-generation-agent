# Selfridges Test Management Agent Readme

> AI-powered QA test case generation platform — React + TypeScript, Claude AI, Jira · Confluence · Zephyr Scale via MCP, dual-mode Knowledge Base (local JSON or pgvector).

---

## Quickstart

```bash
npm install
npm run kb:local:seed       # seed local KB with mock data
npm run ui:build            # compile React → ui/public/
npm run ui:prod             # start server on :3000
```

Open **http://localhost:3000**

---

## What it does

1. **Select** a Jira ticket from the sidebar
2. **Generate** — Claude reads the AC, checks Confluence, retrieves existing Zephyr tests and KB context, generates a full test suite
3. **Review** — paginated modal to edit, include/exclude each test case
4. **Send for Approval** — shareable URL for a teammate to approve/reject each test
5. **Upload Approved** — commits to Zephyr Scale, saves to Knowledge Base, posts Jira comment

---

## Scripts

| Command | What it does |
|---|---|
| `npm run ui:build` | Compile React TypeScript → `ui/public/` |
| `npm run ui:prod` | Start Express server on `:3000` (production) |
| `npm run ui` | Dev mode — server `:3000` + Vite HMR `:5173` |
| `npm run ui:server` | Alias for `ui:prod` |
| `npm run kb:local:seed` | Seed local KB from Jira/Confluence/Zephyr mock data |
| `npm run kb:migrate` | Migrate local KB documents → pgvector (Phase 2) |
| `npm test` | Run all 128 unit tests |
| `npm run test:unit:verbose` | Verbose test output |
| `npm run demo` | CLI demo without UI |

---

## Architecture

```
React UI (Vite + TypeScript)  :5173 dev / :3000 prod
          │
          ▼  HTTP + SSE
Express API Server  (ui/server.ts)  :3000
          │                    │
          │ MCP Protocol        │ Anthropic SDK
          ▼                    ▼
Mock / Live MCP          Claude Sonnet 4    ← generation (prompt cached)
  jira-server.ts         Claude Haiku 4.5  ← classification
  confluence.ts          Voyage-3          ← KB embeddings
  zephyr.ts
          │
          ▼
Knowledge Base (toggle in Config UI)
  Phase 1: local-kb-data/index.json   ← default, zero setup
  Phase 2: PostgreSQL + pgvector      ← shared team KB, semantic search
          │
          ▼
Approval Store (auto-selected with KB backend)
  Phase 1: approvals.json             ← local file
  Phase 2: PostgreSQL table           ← survives restarts, shared
```

---

## Configuration

Everything is configured from the **Config tab** in the UI — no restart needed.

### Data Source Mode
- **Mock** — local DEMO tickets (DEMO-1 to DEMO-4), no credentials needed
- **Live** — real Jira, Confluence, Zephyr Scale

### KB Storage
- **Phase 1 — Local JSON** — stored in `local-kb-data/index.json`, works offline, single machine
- **Phase 2 — pgvector** — PostgreSQL + voyage-3 embeddings, shared across team, semantic search

### AI Provider
- **Claude Code** — default, no API key, uses your subscription
- **Anthropic API** — direct API with prompt caching (90% cheaper on repeated context)
- **OpenAI** — GPT-4o, o3
- **Local Model** — Ollama, LM Studio, any OpenAI-compatible endpoint

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Required for Anthropic API mode + voyage-3 embeddings
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required for Phase 2 KB and approval persistence
DATABASE_URL=postgresql://user:password@host:5432/dbname
KB_BACKEND=pgvector          # or 'local' (default)

# Required for Live mode (Jira/Confluence)
JIRA_URL=https://your-company.atlassian.net
JIRA_USERNAME=you@selfridges.com
JIRA_API_TOKEN=...

CONFLUENCE_URL=https://your-company.atlassian.net/wiki
CONFLUENCE_USERNAME=you@selfridges.com
CONFLUENCE_API_TOKEN=...     # same as Jira on Atlassian Cloud

# Required for Live mode (Zephyr Scale)
ZEPHYR_API_TOKEN=...
ZEPHYR_BASE_URL=https://api.zephyrscale.smartbear.com/v2

# Network
SERVER_IP=10.105.217.140     # your machine IP for team sharing
PORT=3000
```

---

## Phase 2 — pgvector Setup

```bash
# 1. Apply schema to PostgreSQL (once)
#    Copy src/kb/schema.sql into Supabase SQL Editor and run it

# 2. Install postgres client
npm install postgres

# 3. Add to .env
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=sk-ant-...

# 4. Toggle in UI: Config → KB Storage → Phase 2 — pgvector → Save

# 5. Migrate existing local docs (optional)
npm run kb:migrate
```

See `src/kb/schema.sql` for the full schema and `docs/phase2-setup.pdf` for the DevOps guide.

---

## Team Approval Flow

1. Generate tests → Review modal → **📨 Send for Approval** → enter your name
2. Share the URL: `http://10.105.217.140:3000/approve/apr-xxx`
3. Teammate opens it (any device, same network), approves/rejects each test
4. **↑ Upload Approved** unlocks → uploads to Zephyr, saves to KB, posts Jira comment

Approval requests persist across server restarts (Phase 1: `approvals.json`, Phase 2: PostgreSQL).

---

## Project Structure

```
atlassian-test-agent/
├── ui/
│   ├── server.ts                    ← Express API + SSE + MCP orchestration
│   ├── public/
│   │   ├── index.html               ← Setup page (shown before React build)
│   │   └── approve.html             ← Standalone approval page (static)
│   └── client/                      ← React + TypeScript frontend
│       ├── src/
│       │   ├── App.tsx
│       │   ├── index.css            ← Selfridges brand theme
│       │   ├── types/api.ts         ← Shared types (client + server)
│       │   ├── lib/api.ts           ← Typed API client + parseTestCases()
│       │   ├── hooks/useAppState.ts ← Central React state
│       │   ├── components/
│       │   │   ├── Header.tsx
│       │   │   ├── Sidebar.tsx
│       │   │   └── ReviewModal.tsx
│       │   └── pages/
│       │       ├── ConsolePage.tsx
│       │       ├── KBPage.tsx
│       │       ├── ApprovalsPage.tsx
│       │       └── ConfigPage.tsx
│       └── public/
│           └── approve.html         ← Source (copied to ui/public/ on build)
├── src/
│   ├── approvals/
│   │   └── approval-store.ts        ← Local JSON or PostgreSQL approval store
│   ├── kb/
│   │   ├── interface.ts             ← IKnowledgeBase interface
│   │   ├── pg-vector-db.ts          ← Phase 2 pgvector implementation
│   │   ├── schema.sql               ← PostgreSQL schema
│   │   └── migrate.ts               ← Local JSON → pgvector migration
│   ├── knowledge-base/
│   │   ├── formatters.ts            ← Document formatters (no AWS)
│   │   └── types.ts
│   ├── local-kb/
│   │   ├── local-vector-db.ts       ← Phase 1 local JSON vector store
│   │   └── seed.ts                  ← KB seeder
│   └── mocks/
│       ├── jira-server.ts           ← Mock Jira MCP (DEMO-1..4)
│       ├── confluence-server.ts     ← Mock Confluence MCP
│       └── zephyr-server.ts         ← Mock Zephyr MCP
├── tests/
│   └── unit/
│       ├── local-vector-db.test.ts  ← 31 tests
│       ├── test-case-parser.test.ts ← 57 tests
│       └── mock-data.test.ts        ← 40 tests (128 total)
├── CLAUDE.md                        ← Agent instructions
├── .mcp.json                        ← Active MCP config (auto-rewritten)
├── .mcp.mock.json                   ← Mock mode MCP template
├── vite.config.ts
└── package.json
```

---

## Fixing Claude Code Permissions (Mac)

If you see `EACCES` when generating tests:

```bash
# Find the Claude binary
find "$HOME/Library/Application Support/Claude" -path "*/MacOS/claude" -type f

# Fix permissions (replace path with actual result above)
chmod +x "/Users/YOU/Library/Application Support/Claude/claude-code/2.x.x/claude.app/Contents/MacOS/claude"

# Add to PATH permanently
echo 'export PATH="/Users/YOU/Library/Application Support/Claude/claude-code/2.x.x/claude.app/Contents/MacOS:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

The server auto-detects and fixes permissions on startup. If it still fails, use **Config → AI Provider → Anthropic API** instead.

---

## Corporate Network (npm install issues)

If `npm install` fails with `E403` (shell-quote, playwright-core blocked):

```bash
# Switch to personal hotspot, install, then switch back
npm install

# node_modules is saved locally — corporate network only needed for install
# The app itself only needs internet for Anthropic/OpenAI API calls
```

Playwright and concurrently have been removed from dependencies to avoid corporate registry blocks.
