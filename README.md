# Selfridges Test Curator

AI-powered QA test case generation platform — React + TypeScript, Claude AI, Jira · Confluence · Zephyr Scale.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20+** | `node --version` to check |
| **npm 9+** | Comes with Node |
| **Claude Code** | Only needed for the Claude Code AI provider — install from [claude.ai/code](https://claude.ai/code) |

No Python, no uv, no MCP servers required. The app talks directly to Jira, Confluence and Zephyr Scale REST APIs.

---

## Quickstart

```bash
npm install
npm run ui:dev              # start server + Vite (hot reload)
```

Open **http://localhost:3000**, go to **Config**, fill in your credentials, and click **Save & Apply**.

---

## What it does

1. **Select** a Jira ticket from the sidebar
2. **Set filters** — choose Priority (Critical / High / Medium / Low) and Type (Functional / Regression / Edge Case / Negative / Security) in the filter strip above the output panel. Selections are saved automatically.
3. **Generate** — Claude reads the acceptance criteria, fetches related Confluence docs, checks existing Zephyr tests and KB context, and generates a test suite matching your filter selections
4. **Review** — paginated modal to edit, include/exclude each test case
5. **Send for Approval** — shareable URL for a teammate to approve/reject each test
6. **Upload Approved** — creates test cases in Zephyr Scale (linked to the Jira issue), saves to Knowledge Base, posts a Jira comment. If any newly uploaded test is similar to an existing KB entry, the comment includes a duplicate warning.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run ui:dev` | **Normal usage** — server `:3000` + Vite HMR with hot reload |
| `npm run ui:build` | Build React → `ui/public/` (production deploy only) |
| `npm run ui:prod` | Run server only, no Vite (production deploy only) |
| `npm run kb:migrate` | Migrate local KB documents → pgvector |
| `npm test` | Run all unit tests |

---

## Configuration

Everything is configured from the **Config tab** — no restart needed after saving.

### Jira + Confluence

Two auth options:

**Option A — Bearer Token (OAuth / PAT)**
- Paste your OAuth or Personal Access Token into **Bearer Token**
- Leave Username and API Token blank
- The same token is used for both Jira and Confluence

**Option B — Basic Auth**
- Leave Bearer Token blank
- Enter **Username / Email** and **Jira API Token** (from `id.atlassian.com/manage-profile/security/api-tokens`)

**Other fields:**
- **Jira URL** — e.g. `https://your-company.atlassian.net`
- **Project Key** — e.g. `QAP` — filters the issue list
- **Epic Key** (optional) — e.g. `QAP-5` — narrows the sidebar to issues in a specific epic
- **Confluence URL** — e.g. `https://your-company.atlassian.net/wiki`
- **Confluence Space Key** — scopes Confluence searches during generation

### Zephyr Scale

- **Zephyr API Token** — JWT token from Jira → **Apps** → **Zephyr Scale** → **API Tokens**
- **Zephyr Base URL** — `https://api.zephyrscale.smartbear.com/v2` (default; EU: `https://eu.api.zephyrscale.smartbear.com/v2`)

### AI Provider

| Provider | Setup |
|---|---|
| **Claude Code** | Default. No API key — uses your Claude subscription. Requires Claude Code installed. |
| **Anthropic API** | Direct API. Add your `sk-ant-api03-...` key. |
| **OpenAI** | Add your OpenAI API key. Supports GPT-4o, o3. |
| **Local Model** | Ollama, LM Studio, or any OpenAI-compatible endpoint. |

The active provider is shown in the **AI** chip in the header (e.g. `AI: Claude Code`).

---

## Header Status Chips

The header shows live connection status for all services:

| Chip | Green = ready | Red = not configured |
|---|---|---|
| **Jira** | URL + token present | Missing credentials |
| **Confluence** | URL + token present | Missing credentials |
| **Zephyr** | URL + token present | Missing credentials |
| **Knowledge Base** | PostgreSQL reachable | DB unreachable or not configured |
| **AI: \<provider\>** | Provider credentials/binary present | Not configured |

Status refreshes automatically every 30 seconds.

---

## Environment Variables (optional)

Credentials can also be set via `.env` — used as defaults before the UI config overrides them:

```env
# Jira / Confluence — bearer token auth
JIRA_URL=https://api.atlassian.com/ex/jira/{cloudId}
JIRA_BEARER_TOKEN=...
JIRA_PROJECT_KEY=QAP
JIRA_EPIC_KEY=QAP-5          # optional

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

# Knowledge Base (pgvector)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Network
PORT=3000
```

---

## Team Approval Flow

1. Generate tests → Review modal → **Send for Approval** → enter your name
2. Share the approval URL: `http://<your-ip>:3000/approve/apr-xxx`
3. Teammate opens it (any device on the same network), approves/rejects each test with optional comments
4. **Upload Approved** → creates test cases in Zephyr Scale, saves to KB, posts Jira comment

If the uploaded tests are similar to existing KB entries, the Jira comment includes a duplicate warning flagging the overlap.

Approval requests are stored in PostgreSQL (or `approvals.json` as a local fallback) and survive server restarts.

---

## Knowledge Base

The KB stores approved test cases and enriches future generation (avoiding duplicates, reusing patterns).

| Backend | Storage | Use case |
|---|---|---|
| **pgvector** | PostgreSQL + Voyage-3 embeddings | Shared across team, semantic search, duplicate detection |

To set up pgvector: apply `src/kb/schema.sql` to your PostgreSQL database, add `DATABASE_URL` and `ANTHROPIC_API_KEY` to `.env`, then configure in **Config → Database**.

### Zephyr Import & Sync

The **KB tab → Import from Zephyr** button:
- Imports Zephyr test cases not yet in the KB (skips any whose key already appears in a KB document ID)
- Detects and removes KB entries whose Zephyr test case has since been deleted from Zephyr — keeping the KB in sync automatically

### Duplicate Detection

| Similarity | Action |
|---|---|
| ≥ 97% | Older entry auto-deleted |
| ≥ 90% | Older entry flagged as outdated |

When duplicates are detected during an approval upload, a warning is appended to the Jira comment.

---

## Architecture

```
Browser (React + TypeScript)
          │
          ▼  HTTP + SSE
Express API Server  (ui/server.ts)  :3000
          │
          ├── Direct REST API calls
          │     ├── Jira REST API v3
          │     ├── Confluence REST API
          │     └── Zephyr Scale REST API v2
          │
          └── AI generation (Claude Code / Anthropic API / OpenAI / Local)
                └── Context: Jira issue + Confluence docs + Zephyr tests + KB
```

---

## Corporate Network Notes

If `npm install` fails with registry errors, switch to a personal hotspot for the install then switch back. `node_modules` is saved locally — the app only needs network for Jira/Confluence/Zephyr API calls and optionally Anthropic/OpenAI.

---

## Fixing Claude Code Permissions (Mac)

If you see `EACCES` errors during generation:

```bash
# Find the Claude binary path (printed on server startup)
find "$HOME/Library/Application Support/Claude" -path "*/MacOS/claude" -type f

# Fix permissions
chmod +x "/path/to/claude"
```

Alternatively, switch to **Config → AI Provider → Anthropic API**.
