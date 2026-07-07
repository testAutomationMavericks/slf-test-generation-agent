# Selfridges Test Curator — Operational Runbook

This runbook covers initial setup, day-to-day operations, and troubleshooting for
Test Curator. It assumes you are running the app locally or on a server with Node.js ≥ 20.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Starting the App](#starting-the-app)
4. [Day-to-Day Operations](#day-to-day-operations)
5. [Knowledge Base Operations](#knowledge-base-operations)
6. [Configuration Reference](#configuration-reference)
7. [Troubleshooting](#troubleshooting)
8. [Maintenance](#maintenance)

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Node.js | 20.0.0 | Check: `node --version` |
| npm | 9+ | Bundled with Node |
| Jira Cloud | Any tier | Atlassian API token required |
| Zephyr Scale | Cloud | SmartBear API token required |
| Confluence | Cloud | Same Atlassian token as Jira |
| AI provider | Any one | Claude Code CLI **or** Anthropic API key **or** OpenAI key |

**Optional (for pgvector KB):**
- PostgreSQL 16 + pgvector extension (see `docs/DEVOPS_SETUP.md`)
- `ANTHROPIC_API_KEY` (required for Voyage-3 vector embeddings; app falls back to local embedding without it)

---

## Initial Setup

### 1. Install dependencies

```bash
cd slf-test-generation-agent
npm install
```

### 2. Create your .env file

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```env
# Required
JIRA_URL=https://your-company.atlassian.net
JIRA_USERNAME=your.email@company.com
JIRA_API_TOKEN=your-atlassian-token
CONFLUENCE_URL=https://your-company.atlassian.net/wiki
CONFLUENCE_USERNAME=your.email@company.com
CONFLUENCE_API_TOKEN=your-atlassian-token
ZEPHYR_API_TOKEN=your-zephyr-token
JIRA_PROJECT_KEY=QAP

# Optional but recommended
ANTHROPIC_API_KEY=sk-ant-...       # For Anthropic API provider + Voyage-3 embeddings
DATABASE_URL=postgresql://tma:changeme@localhost:5432/tma_kb  # If using pgvector KB
```

### 3. (Optional) Start PostgreSQL via Docker

If using the local Docker KB instead of a managed PostgreSQL instance:

```bash
docker compose up -d
docker compose ps     # tma-kb-postgres should show as "healthy"
```

### 4. Verify the setup in-browser

```bash
npm run ui
```

Navigate to `http://localhost:3000`, go to **Config**, and use the test buttons to verify each connection. The header chips (Jira, Confluence, Zephyr, Knowledge Base, AI) should all turn green when configured correctly.

---

## Starting the App

### Development (recommended for local use)

```bash
npm run ui
```

Starts the Express server (port 3000) and Vite dev server with hot-reload.
The UI is at **http://localhost:3000**.

### Production (server deployment)

```bash
npm run ui:build      # Build React app once
npm run ui:prod       # Start server only (serves built assets)
```

After any code changes in development, rebuild the client before deploying:

```bash
npm run ui:build
```

### Server only (headless / API usage)

```bash
npm run ui:server
```

---

## Day-to-Day Operations

### Generating test cases

1. Open **http://localhost:3000**
2. In the **Console** tab:
   - Select a Jira issue from the left sidebar
   - Check the filter strip — set **Priority** (Critical / High / Medium / Low) and **Type** (Functional / Regression / Edge Case / Negative / Security) for this generation. Selections persist automatically.
   - (Optional) Type a custom prompt at the bottom to focus generation. Custom prompts bypass the Priority/Type filters.
   - Click **⚡ Generate Tests**
3. Wait for generation (1–3 min for Claude Code, 30–90s for Anthropic API)
4. Output appears in the main panel; existing Zephyr tests appear on the right

**Updating a single test:** Click **✏ Edit** on a Zephyr test in the right panel to populate
the prompt bar with that test's key, then click **Send**. Filters do not apply — only that
one test is updated.

**Clearing output:** Click **✕ Clear** to wipe the output panel and start fresh.

### Sending for approval

1. Click **↑ Review & Upload to Zephyr** (yellow button, visible once output exists)
2. Review and edit each test case (name, priority, type, steps)
3. Untick any test cases to exclude
4. Set the Zephyr folder name (default: "Generated")
5. Click **Send for Approval** → enter your name → confirm
6. A shareable URL is copied to your clipboard — send it to your reviewer

### Uploading approved tests

1. Go to the **Approvals** tab or open the Review Modal
2. Wait for status to show **Approved** or **Partial** (refresh if needed)
3. Click **Upload Approved**
4. Tests are created in Zephyr, linked to the Jira issue, and saved to the KB
5. A Jira comment is posted listing the new test keys
6. If any uploaded test is similar to an existing KB entry, the comment includes a duplicate
   warning — check it and retire the older Zephyr test if appropriate

### Viewing and managing approvals

Go to the **Approvals** tab:
- **🔗 Open** → opens the approval review page
- **📋 Copy Link** → copies URL to clipboard
- **↑ Upload** → triggers Zephyr upload (only available when approved/partial)
- **✕ Delete** → removes the approval request permanently

---

## Knowledge Base Operations

### Import from Zephyr

Use the KB tab → **Import from Zephyr** button to bulk-import existing Zephyr test cases:
- Skips any whose key already appears in a KB document (whether as `zephyr:QAP-T131` or `generated:QAP-T131:QAP-12`)
- **Automatically removes stale KB entries** whose Zephyr test case has been deleted

Run this regularly (after deleting tests in Zephyr, or after a sprint cleanup) to keep the KB in sync.

### Migrate to pgvector

Run this once when your PostgreSQL database is ready. Re-embeds existing data with Voyage-3 and
runs a post-migration duplicate scan.

```bash
npm run kb:migrate
```

Requires `DATABASE_URL` and `ANTHROPIC_API_KEY` in `.env`.

### Interactive KB Manager

```bash
npm run kb
```

| Option | What it does |
|--------|-------------|
| View KB stats | Counts total, active, outdated entries |
| Search KB entries | Full-text search by title, feature area, or Zephyr key |
| View outdated / stale entries | Lists entries flagged as outdated or not updated in 90+ days |
| View duplicate log | Shows recent duplicate detections and actions taken |
| Flag entry as outdated | Mark a specific entry as outdated with a reason |
| Delete entry | Permanently remove one entry |
| Delete all for a feature | Purge all entries for a given feature area |
| Run duplicate scan | Scan entire KB for near-duplicates and report findings |

### Clear the KB

```bash
# Via UI: KB tab → Clear button (with confirmation)
# Via API:
curl -X DELETE http://localhost:3000/api/kb/clear
```

---

## Configuration Reference

All config is managed through the **Config tab** or via `.env`. The UI writes to
`ui-config.json` which takes priority over `.env`.

### Generation Preferences

Stored automatically via the Console filter strip. Saved to `ui-config.json` as:

```json
{
  "genPriorities": ["Critical", "High"],
  "genTypes": ["Functional", "Regression", "Edge Case", "Negative", "Security"]
}
```

Can also be read/written via:
```
GET  /api/gen-options
POST /api/gen-options  { "priorities": [...], "types": [...] }
```

### AI Providers

| Setting | Config tab field | .env variable |
|---------|-----------------|---------------|
| Provider | AI Provider radio | — |
| Anthropic key | API Key | `ANTHROPIC_API_KEY` |
| Claude model | Model dropdown | `CLAUDE_MODEL` |
| OpenAI key | API Key | `OPENAI_API_KEY` |
| OpenAI model | Model dropdown | `OPENAI_MODEL` |
| Local URL | Base URL | `LOCAL_MODEL_URL` |
| Local model | Model name | `LOCAL_MODEL` |

### Jira & Confluence

| Setting | Config tab field | .env variable |
|---------|-----------------|---------------|
| Jira URL | Connection URL | `JIRA_URL` |
| Bearer token | Bearer Token | `JIRA_BEARER_TOKEN` |
| Jira username | Username | `JIRA_USERNAME` |
| Jira API token | API Token | `JIRA_API_TOKEN` |
| Project key | Project Key | `JIRA_PROJECT_KEY` |
| Epic key (optional) | Epic Key | `JIRA_EPIC_KEY` |
| Confluence URL | Confluence URL | `CONFLUENCE_URL` |
| Confluence token | Confluence Token | `CONFLUENCE_API_TOKEN` |

### Zephyr

| Setting | Config tab field | .env variable |
|---------|-----------------|---------------|
| API token | Zephyr API Token | `ZEPHYR_API_TOKEN` |
| Base URL | Zephyr Base URL | `ZEPHYR_BASE_URL` |

> EU region URL: `https://eu.api.zephyrscale.smartbear.com/v2`

### Knowledge Base

| Setting | Config tab field | .env variable |
|---------|-----------------|---------------|
| DB connection URL | EC2 Connection URL | `DATABASE_URL` |
| Database name | Database Name | `DB_NAME` |
| Auto-delete threshold | — | `KB_AUTO_DELETE_THRESHOLD` (default: 0.97) |
| Flag threshold | — | `KB_FLAG_THRESHOLD` (default: 0.90) |

---

## Troubleshooting

### Header chip stays red despite correct credentials

The status endpoint runs live checks every 30 seconds. After saving config:
1. Wait up to 30 seconds for the next poll, or refresh the page
2. For **Knowledge Base**: the DB check times out after 3 seconds — if the connection is slow, it may show red even when the DB is reachable. Check the Config → Test DB button for a detailed 3-step result.
3. For **Confluence**: the chip uses the same Jira token if a dedicated Confluence API token is not set — this is correct behaviour on Atlassian Cloud.

---

### "Claude Code binary not found"

```bash
# Install:
npm install -g @anthropic-ai/claude-code

# Verify:
claude --version
```

Alternatively, switch to **Anthropic API** in Config — no CLI needed.

---

### "Database connection failed" / KB chip stays red

1. Check `DATABASE_URL` is correct in Config tab
2. For Docker: `docker compose ps` — container should be healthy
3. For EC2: security group must allow port 5432 from the app server
4. Use Config → Test DB for a 3-step result:
   - Step 1 fail → host unreachable (network/firewall)
   - Step 2 fail → host OK but wrong credentials or DB does not exist
   - Step 3 fail → connected but schema not applied

---

### "Jira issues not loading" / sidebar empty

1. Config → Test Jira
2. Verify `JIRA_PROJECT_KEY` matches your project
3. If Epic Key is set, verify it exists in the project
4. JQL: `project = {key} [AND "Epic Link" = {epicKey}] ORDER BY updated DESC LIMIT 30`

---

### "Zephyr test cases not loading"

1. Config → Test Zephyr
2. Check `ZEPHYR_BASE_URL` — EU region needs `https://eu.api.zephyrscale.smartbear.com/v2`
3. Tests must be linked to the Jira issue or labelled with the issue key to appear in the panel

---

### Generation produces too many tests / wrong priorities

1. Check the filter strip — unselect the priorities/types you don't want
2. Filters apply only to **⚡ Generate Tests**; they do not affect **↻ Update** or **✏ Edit**
3. If Claude ignores the filters, check the server logs — the constraint block should appear
   at the top of the prompt

---

### Update button generates a full suite instead of updating one test

Use **✏ Edit** on the specific Zephyr test in the right panel (not the ↻ Update button).
Edit populates the prompt bar with `Update test case QAP-Txxx:` and sends as a custom prompt,
which bypasses filters and targets only that test.

---

### Approval page shows error / "missing test cases"

This can occur if the approval was created before a server migration. Delete the broken
approval request and send for approval again from the Review Modal.

If it happens consistently, check server logs for `PgApprovalStore: data for "apr-xxx" was a string`
— this indicates a PostgreSQL JSONB serialisation issue. The server logs the full data for diagnosis.

---

### "PgApprovalStore: EC2 not reachable" in logs

Informational only. The approval store has fallen back to `approvals.json`. All approvals
work normally. When EC2 becomes available (on next server start with a valid connection),
new approvals go to PostgreSQL.

---

### Zephyr import re-imports tests that were already uploaded

The importer checks whether the Zephyr key appears anywhere in a KB document ID — including
`generated:QAP-T131:QAP-12` style IDs from approval uploads. If a test is still being
re-imported, run the import again (the check uses fresh IDs from the DB each time).

---

### "Skipped N outdated KB entries" warning during generation

Near-duplicate entries exist in the KB. They are excluded from retrieval correctly but
should be reviewed:

```bash
npm run kb
# → View outdated / stale entries
# → Delete or restore as appropriate
```

---

## Maintenance

### Weekly

- **Review the duplicate log:** `npm run kb` → View duplicate log
  Check whether auto-deletions and flags look correct
- **Run Zephyr import** to sync deleted tests out of the KB

### Monthly

- **Scan for new duplicates:** `npm run kb` → Run duplicate scan on full KB
- **Review outdated entries:** `npm run kb` → View outdated / stale entries
  (entries older than 90 days are surfaced automatically)

### Before a major sprint

- **Run Zephyr import** to pull in any new tests and clear deleted ones
- **Check Zephyr folder structure** — set the folder name in the Review Modal before upload
- **Verify DB connection** — Config tab → Test DB

### Rotating credentials

Update in Config tab → Save & Apply. No restart required — config hot-swaps immediately.

For environment variable changes in a deployment, restart the server after updating.

### Rebuilding the client (after code changes)

```bash
npm run ui:build
```

Outputs to `ui/public/`. Stale `.js` files from `tsc` in `ui/client/src/` will cause Vite
to pick up compiled files instead of TypeScript sources — if the build fails with JSX errors,
delete the `.js` files first:

```bash
find ui/client/src -name "*.js" -delete && npm run ui:build
```

### Backing up the Knowledge Base

**pgvector KB:**
```bash
pg_dump "postgresql://tma:<password>@<host>:5432/tma_kb" \
  --format=custom \
  --file="tma_kb_$(date +%Y%m%d).dump"

# Restore:
pg_restore -d tma_kb tma_kb_20260707.dump
```

**Approvals (local fallback):**
```bash
cp approvals.json approvals.json.backup
```
