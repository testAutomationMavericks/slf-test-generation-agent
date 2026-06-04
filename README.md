# Selfridges Test Management Agent

AI-powered QA test case generation platform — React + TypeScript, Claude AI, Jira · Confluence · Zephyr Scale.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | `node --version` to check |
| **npm 9+** | Comes with Node |
| **Claude Code** | Only needed for the Claude Code AI provider — install from [claude.ai/code](https://claude.ai/code) |

No Python, no uv, no MCP servers required for live mode. In live mode the app talks directly to Jira, Confluence and Zephyr Scale REST APIs.

---

## Quickstart

```bash
npm install
npm run ui:build            # compile React → ui/public/
npm run ui:prod             # start server on :3000
```

Open **http://localhost:3000**, go to **Config**, fill in your credentials, and set mode to **Live**.

---

## What it does

1. **Select** a Jira ticket from the sidebar
2. **Generate** — Claude reads the acceptance criteria, fetches related Confluence docs, checks existing Zephyr tests and KB context, generates a full test suite
3. **Review** — paginated modal to edit, include/exclude each test case
4. **Send for Approval** — shareable URL for a teammate to approve/reject each test
5. **Upload Approved** — creates test cases in Zephyr Scale (linked to the Jira issue), saves to Knowledge Base, posts a Jira comment

---

## Scripts

| Command | What it does |
|---|---|
| `npm run ui:build` | Compile React TypeScript → `ui/public/` |
| `npm run ui:prod` | Start Express server on `:3000` (production) |
| `npm run ui` | Dev mode — server `:3000` + Vite HMR `:5173` |
| `npm run kb:local:seed` | Seed local KB from mock data |
| `npm run kb:migrate` | Migrate local KB documents → pgvector (Phase 2) |
| `npm test` | Run all unit tests |

---

## Configuration

Everything is configured from the **Config tab** in the UI — no restart needed after saving.

### Data Source Mode
- **Mock** — local DEMO tickets (DEMO-1 to DEMO-4), no credentials needed, good for testing the app
- **Live** — real Jira, Confluence, Zephyr Scale via direct REST API

### Jira + Confluence

Two auth options — use whichever your team has set up:

**Option A — Bearer Token (OAuth / PAT)**
- Paste your OAuth or Personal Access Token into the **Bearer Token** field
- Leave Username and API Token fields blank
- The same token is used for both Jira and Confluence

**Option B — Basic Auth**
- Leave Bearer Token blank
- Enter your **Username / Email** and **Jira API Token** (generated at `id.atlassian.com/manage-profile/security/api-tokens`)
- Enter your **Confluence API Token** (same token on Atlassian Cloud)

**Other fields:**
- **Jira URL** — e.g. `https://api.atlassian.com/ex/jira/{cloudId}` or `https://your-company.atlassian.net`
- **Project Key** — e.g. `QAP` — used to filter the issue list
- **Confluence URL** — e.g. `https://api.atlassian.com/ex/confluence/{cloudId}/wiki` or `https://your-company.atlassian.net/wiki`
- **Confluence Space Key** — e.g. `QAP` — scopes Confluence searches to your team's space during generation

### Zephyr Scale

- **Zephyr API Token** — JWT token generated from within Zephyr Scale:  
  Jira → **Apps** → **Zephyr Scale** → **API Tokens** → **Generate Access Token**
- **Zephyr Base URL** — `https://api.zephyrscale.smartbear.com/v2` (default, correct for Cloud)

### AI Provider

| Provider | Setup |
|---|---|
| **Claude Code** | Default. No API key needed — uses your Claude subscription. Requires Claude Code installed. |
| **Anthropic API** | Direct API. Add your `sk-ant-api03-...` key. Includes prompt caching. |
| **OpenAI** | Add your OpenAI API key. Supports GPT-4o, o3. |
| **Local Model** | Ollama, LM Studio, or any OpenAI-compatible endpoint. |

---

## Environment Variables (optional)

Credentials can also be set via `.env` — these are used as defaults before the UI config overrides them:

```env
# Jira / Confluence — bearer token auth
JIRA_URL=https://api.atlassian.com/ex/jira/{cloudId}
JIRA_BEARER_TOKEN=...
JIRA_PROJECT_KEY=QAP

CONFLUENCE_URL=https://api.atlassian.com/ex/confluence/{cloudId}/wiki
CONFLUENCE_SPACE_KEY=QAP

# Jira / Confluence — basic auth (alternative)
JIRA_USERNAME=you@selfridges.com
JIRA_API_TOKEN=...
CONFLUENCE_USERNAME=you@selfridges.com
CONFLUENCE_API_TOKEN=...

# Zephyr Scale
ZEPHYR_API_TOKEN=eyJ0eXAiOiJKV1Qi...
ZEPHYR_BASE_URL=https://api.zephyrscale.smartbear.com/v2

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...

# Phase 2 KB (optional)
DATABASE_URL=postgresql://user:password@host:5432/dbname
KB_BACKEND=pgvector

# Network
PORT=3000
```

---

## Team Approval Flow

1. Generate tests → Review modal → **Send for Approval** → enter your name
2. Share the approval URL: `http://<your-ip>:3000/approve/apr-xxx`
3. Teammate opens it (any device on the same network), approves/rejects each test
4. **Upload Approved** unlocks → creates test cases in Zephyr Scale (linked to the Jira issue), saves to KB, posts Jira comment

Approval requests survive server restarts — stored in `approvals.json` (Phase 1) or PostgreSQL (Phase 2).

---

## Knowledge Base

The KB stores approved test cases and is used to enrich future generation (avoiding duplicates, reusing patterns).

| Mode | Storage | Use case |
|---|---|---|
| **Phase 1 — Local JSON** | `local-kb-data/index.json` on disk | Default, zero setup, single machine |
| **Phase 2 — pgvector** | PostgreSQL + voyage-3 embeddings | Shared across team, semantic search |

To switch to pgvector: apply `src/kb/schema.sql` to your PostgreSQL database, add `DATABASE_URL` and `ANTHROPIC_API_KEY` to `.env`, then toggle in **Config → KB Storage**.

---

## Architecture

```
Browser (React + TypeScript)
          │
          ▼  HTTP + SSE
Express API Server  (ui/server.ts)  :3000
          │
          ├── Live mode: direct REST API calls
          │     ├── Jira REST API v3
          │     ├── Confluence REST API
          │     └── Zephyr Scale REST API v2
          │
          ├── Mock mode: local MCP mock servers
          │     ├── src/mocks/jira-server.ts
          │     ├── src/mocks/confluence-server.ts
          │     └── src/mocks/zephyr-server.ts
          │
          └── AI generation (Claude Code / Anthropic API / OpenAI / Local)
                └── Context: Jira issue + Confluence docs + Zephyr tests + KB
```

---

## Corporate Network Notes

If `npm install` fails with registry errors:

```bash
# Switch to personal hotspot for the install, then switch back
npm install
```

`node_modules` is saved locally — the app only needs network access for:
- Jira, Confluence, Zephyr Scale API calls (your corporate network)
- Anthropic/OpenAI API calls (if using API provider mode)

---

## Fixing Claude Code Permissions (Mac)

If you see `EACCES` errors during generation:

```bash
# Find the Claude binary path (the server prints this on startup)
find "$HOME/Library/Application Support/Claude" -path "*/MacOS/claude" -type f

# Fix permissions
chmod +x "/path/to/claude"
```

The server auto-detects and fixes permissions on startup. If generation still fails, switch to **Config → AI Provider → Anthropic API** as an alternative.
