# Selfridges Test Management Agent

> Enterprise QA test case generator — React + TypeScript UI, Claude Code or Anthropic API, Jira · Confluence · Zephyr via MCP, local Knowledge Base with voyage-3 embeddings and prompt caching.

---

## Quickstart

```bash
npm install
npm run kb:local:seed    # seed local KB with mock data
npm run ui               # starts server (3000) + Vite dev server (5173)
```

Open **http://localhost:5173** (dev) or **http://localhost:3000** (production build).

For production: build the React app first:
```bash
npm run ui:build         # builds React → ui/public/
npm run ui:server        # serve from port 3000 only
```

---

## Claude Code (recommended — no API key)

```bash
cp .mcp.mock.json .mcp.json
claude                   # in project root — reads CLAUDE.md + .mcp.json
```

---

## Architecture (Phase 1)

```
React UI (Vite + TypeScript)
        ↓
Express API server (ui/server.ts)
        ↓                    ↓
Mock MCP servers         Anthropic API
(Jira/Confluence/Zephyr) ├── Claude Sonnet 4 (generation) — prompt caching
                         ├── Claude Haiku 4.5 (classification)
                         └── Voyage-3 (embeddings)
                              ↓
                         Local KB (JSON vector store)
```

**Prompt caching** — CLAUDE.md + domain knowledge sent once, cached for 5 min (90% cheaper on repeated context).

**Haiku routing** — classification and simple tasks use Haiku ($1/M) instead of Sonnet ($3/M).

**Voyage-3 embeddings** — real semantic embeddings for KB retrieval when Anthropic API key is set.

---

## Running modes

| Command | What it does |
|---|---|
| `npm run ui` | Dev mode — server + Vite HMR |
| `npm run ui:server` | Server only (serves built React from ui/public/) |
| `npm run ui:build` | Build React app to ui/public/ |
| `npm run kb:local:seed` | Seed local KB from mock data |
| `npm run demo` | CLI demo (no UI) |

---

## Switch mock ↔ live

In the UI: **Config → Data Source Mode → Live**

Or via `.env`:
```env
JIRA_URL=https://your-company.atlassian.net
JIRA_USERNAME=you@company.com
JIRA_API_TOKEN=...
ZEPHYR_API_TOKEN=...
SERVER_IP=10.105.217.140   # your machine's IP for team sharing
```

---

## Team approval flow

1. Generate tests → Review modal → **📨 Send for Approval**
2. Share link: `http://10.105.217.140:3000/approve/apr-xxx`
3. Teammate reviews at `approve.html`, approves/rejects each test
4. **↑ Upload Approved** unlocks → pushes to Zephyr + KB + posts Jira comment
