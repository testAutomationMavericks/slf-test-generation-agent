# TMA — Operational Runbook

This runbook covers initial setup, day-to-day operations, and troubleshooting for the
TMA (Test Management Agent). It assumes you are running TMA locally or on a server
with Node.js ≥ 20 installed.

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
| AI provider | Any one | Claude Code CLI **or** Anthropic API key |

**Optional (for EC2 KB):**
- PostgreSQL 16 + pgvector extension (see `docs/DEVOPS_SETUP.md`)
- `ANTHROPIC_API_KEY` (required for voyage-3 vector embeddings)

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
ANTHROPIC_API_KEY=sk-ant-...         # For AI generation + voyage-3 embeddings
JIRA_URL=https://your-company.atlassian.net
JIRA_USERNAME=your.email@company.com
JIRA_API_TOKEN=your-atlassian-token
CONFLUENCE_URL=https://your-company.atlassian.net/wiki
CONFLUENCE_USERNAME=your.email@company.com
CONFLUENCE_API_TOKEN=your-atlassian-token
ZEPHYR_API_TOKEN=your-zephyr-token

# Optional but recommended
DEFAULT_JIRA_PROJECT=SLF             # Your Jira project key
DATABASE_URL=postgresql://tma:changeme@localhost:5432/tma_kb  # If using EC2/Docker
```

### 3. (Optional) Start PostgreSQL via Docker

If you are using the local Docker KB instead of a managed EC2 instance:

```bash
docker compose up -d
# Waits ~10 seconds for healthy state, then:
docker compose ps     # should show tma-kb-postgres as "healthy"
```

### 4. Verify the setup in-browser

```bash
npm run ui
```

Navigate to `http://localhost:3000`, go to **Config**, and use the test buttons to verify
each connection:
- Jira ✓
- Confluence ✓
- Zephyr ✓
- EC2 (if configured) ✓

---

## Starting the App

### Development (recommended for local use)

```bash
npm run ui
```

This starts both the Express server (port 3001) and the Vite dev server (port 3000) with
hot-reload. The UI is at **http://localhost:3000**.

### Production (server deployment)

```bash
npm run ui:build      # Build React app once
npm run ui:prod       # Start server only (serves built assets)
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
   - (Optional) Type a custom prompt at the bottom to focus generation
   - Click **Generate Tests**
3. Wait for generation to complete (1–3 min for Claude Code, 30–90s for Anthropic API)
4. The output appears in the main panel; existing Zephyr tests appear in the right panel

### Sending for approval

1. Click **Review & Upload** to open the Review Modal
2. Review and edit each test case (name, priority, type, steps)
3. Untick any test cases you want to exclude
4. Set the Zephyr folder name (default: "Generated")
5. Click **Send for Approval** → enter your name → confirm
6. A shareable URL is copied to your clipboard — send it to your reviewer

### Uploading approved tests

Once your reviewer approves:

1. Go to the **Approvals** tab or open the Review Modal
2. Wait for status to show **Approved** or **Partial** (refresh if needed)
3. Click **Upload Approved**
4. Tests are created in Zephyr, linked to the Jira issue, and saved to the KB
5. A Jira comment is posted listing the new test keys

### Viewing and managing approvals

Go to the **Approvals** tab to see all approval requests:
- 🔗 Open → opens the approval review page
- 📋 Copy Link → copies URL to clipboard
- ↑ Upload → triggers Zephyr upload (only available if approved/partial)
- ✕ Delete → removes the approval request permanently

---

## Knowledge Base Operations

### Seed the local KB (first time)

```bash
# Via UI: KB tab → Re-seed button
# Or via CLI:
npm run kb:local:seed
```

### Migrate local KB to EC2

Run this once when your EC2 / Docker PostgreSQL is ready. Re-embeds all local documents
with Voyage-3 and runs a post-migration duplicate scan.

```bash
npm run kb:migrate
```

Requires `DATABASE_URL` and `ANTHROPIC_API_KEY` in `.env`.

### Interactive KB Manager (EC2 mode)

```bash
npm run kb
```

| Option | What it does |
|--------|-------------|
| View KB stats | Counts total, active, outdated entries; shows feature/sprint breakdown |
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
curl -X DELETE http://localhost:3001/api/kb/clear
```

---

## Configuration Reference

All config is managed through **Config tab** in the UI or via `.env`. The UI writes to
`ui-config.json` which takes priority over `.env`.

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
| Jira token | API Token | `JIRA_API_TOKEN` |
| Jira username | Username | `JIRA_USERNAME` |
| Project key | Project Key | `DEFAULT_JIRA_PROJECT` |
| Epic key | Epic Key (optional) | `JIRA_EPIC_KEY` |
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
| EC2 connection URL | EC2 Connection URL | `DATABASE_URL` |
| Database name | Database Name | `DB_NAME` |
| Auto-delete threshold | — | `KB_AUTO_DELETE_THRESHOLD` (default: 0.97) |
| Flag threshold | — | `KB_FLAG_THRESHOLD` (default: 0.90) |

---

## Troubleshooting

### "Claude Code binary not found"

The Claude Code CLI is not installed or not on PATH.

```bash
# Install:
npm install -g @anthropic-ai/claude-code

# Verify:
claude --version

# If still not found, check PATH:
which claude
```

Alternatively, switch to **Anthropic API** in Config tab — no CLI needed.

---

### "Database connection failed" / EC2 test step 1 fails

The server cannot reach the PostgreSQL host.

1. Check `DATABASE_URL` is correct in Config tab
2. For Docker: verify container is running — `docker compose ps`
3. For EC2: verify security group allows port 5432 from your IP
4. Run the 3-step test in Config → EC2 section to isolate which step fails:
   - Step 1 fail → host unreachable (network / firewall issue)
   - Step 2 fail → host OK but database does not exist or wrong credentials
   - Step 3 fail → connected but schema not applied

If you see "not connected" in server logs but DATABASE_URL is set, the app has fallen
back to local JSON — approvals and KB still work, just without pgvector features.

---

### "Jira issues not loading" / sidebar empty

1. Check Jira URL and token in Config → Test Jira
2. If using Epic Key filter, verify the epic key exists in your project
3. Check that `DEFAULT_JIRA_PROJECT` matches your actual Jira project key
4. JQL used: `project = {key} [AND "Epic Link" = {epicKey}] ORDER BY updated DESC LIMIT 30`

---

### "Zephyr test cases not loading"

1. Check Zephyr API token in Config → Test Zephyr
2. Verify `ZEPHYR_BASE_URL` — if on EU region use `https://eu.api.zephyrscale.smartbear.com/v2`
3. Zephyr tests are matched by linked issue or label — if neither is set on the Zephyr test, it will not appear
4. Max 500 tests returned per lookup

---

### Generation produces generic / low-quality output

In priority order:

1. **Seed the KB** — go to KB tab → Re-seed. An empty KB means Claude has no examples of your team's test style
2. **Enrich the Jira ticket** — add acceptance criteria, description, and component info
3. **Add a Confluence page** for the feature and link it or mention the issue key in the page
4. **Use a custom prompt** to focus Claude — e.g. "Generate edge cases only for the payment flow"
5. **Switch to Claude Code or Sonnet** if using Haiku or a local model

---

### Approval stuck in "Pending" — reviewer says they submitted

The approval page status does not auto-push to the Console. Manually refresh:

- **Approvals tab** → Refresh button
- **Review Modal** → close and re-open

If still pending after refresh, check that the reviewer actually clicked **Submit Review**
(not just toggling checkboxes — the button must be clicked).

---

### Upload to Zephyr fails for some tests

Partial failures are expected if Zephyr rejects a test case. The upload endpoint returns
`{ uploadedCount, failedCount }` — check the browser console or server logs for the specific
Zephyr error (usually a field validation failure).

Common causes:
- Test case name exceeds Zephyr limits (trim it in the Review Modal)
- Objective / description text too long (500 char limit for objective field)
- Jira issue ID could not be resolved — verify the issue key is valid

---

### "PgApprovalStore: EC2 not reachable" warning in logs

This is informational, not an error. The approval store has automatically fallen back to
`approvals.json`. All approvals will be saved locally and work normally.

When EC2 becomes available (after the server restarts with a valid connection), new approvals
go to PostgreSQL. Approvals already in `approvals.json` are not migrated automatically.

---

### "Skipped N outdated KB entries" warning during generation

Near-duplicate entries exist in the KB flagged as outdated. They are excluded from retrieval
correctly, but you should review them:

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
- **Purge stale features:** If a feature area has been retired, purge its KB entries:
  `npm run kb` → Delete all for a feature

### Monthly

- **Scan for new duplicates:** `npm run kb` → Run duplicate scan on full KB
  New test patterns can create duplicates over time
- **Review outdated entries:** `npm run kb` → View outdated / stale entries
  Entries older than 90 days are surfaced automatically

### Before a major sprint

- **Re-seed KB** if your team has significantly changed its testing style
- **Check Zephyr folder structure** — decide if tests should go into a sprint-specific folder
  (set in Review Modal before upload)
- **Verify EC2 connection** — Config tab → Test EC2 Connection

### Rotating credentials

Update credentials in Config tab → Save & Apply. No restart required — config hot-swaps.

For environment variable changes (e.g. rotating `JIRA_API_TOKEN` in a deployment), restart
the server after updating the variable.

### Backing up the Knowledge Base

**Local KB:**
```bash
cp local-kb-data/index.json local-kb-data/index.json.backup
```

**EC2 / pgvector KB:**
```bash
pg_dump "postgresql://tma:<password>@<host>:5432/tma_kb" \
  --format=custom \
  --file="tma_kb_$(date +%Y%m%d).dump"

# Restore:
pg_restore -d tma_kb tma_kb_20260702.dump
```

**Approvals (local fallback):**
```bash
cp approvals.json approvals.json.backup
```
