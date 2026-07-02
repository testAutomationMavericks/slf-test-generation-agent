# TMA — User Guide

**TMA (Test Management Agent)** is an AI-powered test case generation tool that reads your
Jira tickets, pulls in Confluence documentation and existing Zephyr tests, then generates
comprehensive, structured test cases ready for peer review and upload to Zephyr Scale.

---

## Table of Contents

1. [What TMA Can Do](#what-tma-can-do)
2. [What TMA Cannot Do](#what-tma-cannot-do)
3. [AI Providers](#ai-providers)
4. [Knowledge Base](#knowledge-base)
5. [Approval Workflow](#approval-workflow)
6. [Dos and Don'ts](#dos-and-donts)
7. [Limitations & Known Constraints](#limitations--known-constraints)

---

## What TMA Can Do

### Test Case Generation
- Reads a Jira issue (summary, description, acceptance criteria, custom fields) and generates
  a full set of test cases automatically
- Pulls in related **Confluence documentation** (spec pages, architecture docs) to enrich context
- Checks **existing Zephyr tests** for the issue so it doesn't duplicate what's already there
- Searches the **Knowledge Base** for similar approved test patterns from past work
- Generates test cases covering: happy path, negative cases, edge cases, boundary values,
  and security considerations
- Every test case includes: name, type, priority, preconditions, step-by-step actions with
  expected results, and a summary outcome
- Supports a **custom prompt** — leave it blank for full auto-generation, or type a specific
  instruction (e.g. "Focus only on payment failure scenarios")

### Approval Workflow
- After generation, opens a **Review Modal** where you can edit any test case before sending
- Generates a **shareable approval URL** — send it to a teammate who can review and approve/reject
  each test case individually with comments
- The approval page works in any browser with no login required
- Tracks approval status: pending → approved / partial / rejected → uploaded

### Zephyr Upload
- Uploads only the **approved test cases** to Zephyr Scale
- Creates test cases with full steps, links them to the originating Jira issue, and places them
  in a configurable folder (default: "Generated")
- Posts a **Jira comment** on the ticket summarising which test keys were created
- Saves uploaded tests to the Knowledge Base for future reuse

### Knowledge Base
- Stores approved test cases as vector embeddings for semantic search
- **Local mode (no EC2):** Simple keyword + n-gram hashing, works offline, no external dependencies
- **EC2 / pgvector mode:** Voyage-3 AI embeddings for high-accuracy semantic similarity search
- Automatic **duplicate detection** in EC2 mode:
  - ≥ 97% similarity → older entry auto-deleted
  - ≥ 90% similarity → older entry flagged for manual review
  - All deduplication actions logged to `duplicate_log`
- `npm run kb` launches an interactive KB Manager CLI: search, flag, delete, purge, scan

### Configuration (Config Tab)
- All credentials configurable in-browser (Jira, Confluence, Zephyr, AI provider, EC2 DB)
- 3-step EC2 connection test: host reachable → database accessible → schema ready
- Individual test buttons for Jira, Confluence, and Zephyr connections
- Changes take effect immediately (hot-swap) — no server restart needed

---

## What TMA Cannot Do

- **Does not modify Jira issues** except to post a comment after successful upload
- **Does not delete tests from Zephyr** — flagged/outdated entries are managed in the KB only;
  you must archive tests in Zephyr Scale manually
- **Does not auto-approve** — a human must always review before upload
- **Does not generate tests without a Jira issue** as a starting point (though you can override
  with a custom prompt if the ticket is missing detail)
- **Does not support Zephyr Server/Data Center** — only Zephyr Scale (Cloud) is supported
- **Does not support AWS Bedrock KB** — config fields exist but the integration is not implemented
- **Does not run in your CI/CD pipeline** — it is a human-in-the-loop tool, not an automated runner

---

## AI Providers

TMA supports four AI providers. Switch between them in the **Config tab**.

| Provider | Best For | Requires |
|----------|----------|----------|
| **Claude Code** (recommended) | Best output quality; uses your local Claude CLI | Claude Code CLI installed |
| **Anthropic API** | Cloud-based, no CLI needed | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-4o alternative | `OPENAI_API_KEY` |
| **Local (Ollama etc.)** | Fully offline, no cost | Local model server running |

**Model selection (Anthropic API mode):**
TMA automatically selects the model based on your prompt. Prompts containing "Generate" or
"test case" use Claude Sonnet (more powerful); simpler follow-up prompts use Claude Haiku
(faster, cheaper).

---

## Knowledge Base

The KB stores approved, uploaded test cases so future generations benefit from your team's
accumulated test patterns.

### When it is used
- **During generation:** Top-K semantically similar past tests are injected into the prompt
  as examples, improving consistency and coverage
- **After upload:** Each uploaded test is automatically saved to the KB

### Two backends

**Local (no EC2 configured)**
- Stored in `local-kb-data/index.json`
- Uses keyword + n-gram similarity (deterministic, no API calls)
- Adequate for getting started; similarity search is less accurate than vector embeddings
- No duplicate detection

**EC2 / pgvector (DATABASE_URL configured)**
- Stored in PostgreSQL with pgvector extension
- Uses Voyage-3 AI embeddings (1024 dimensions) — requires `ANTHROPIC_API_KEY`
- Semantic search understands meaning, not just keywords
- Full duplicate detection with auto-delete and flagging

### Migrating from local to EC2
```bash
npm run kb:migrate
```
This re-embeds all local documents with Voyage-3 and pushes them to EC2. After migration
a duplicate scan runs automatically to flag any pre-existing near-duplicates.

---

## Approval Workflow

```
Generate → Review & Edit → Send for Approval → Teammate Reviews → Upload to Zephyr
```

### Step 1 — Generate
Select a Jira issue from the sidebar and click **Generate Tests**. Wait for the output
(Claude Code can take 1–3 minutes). When complete, the **Review & Upload** button activates.

### Step 2 — Review & Edit
Click **Review & Upload** to open the Review Modal.
- Navigate between test cases using ‹ / › or the numbered thumbnails at the top
- Edit any field: name, priority, type, preconditions, full content
- Untick the checkbox to exclude a test case from the approval batch
- Set the **Zephyr folder** name (default: "Generated")

### Step 3 — Send for Approval
Click **Send for Approval**, enter your name, and confirm.
- A shareable URL is generated and copied to your clipboard automatically
- Send this link to your reviewer — they do not need to log in

### Step 4 — Teammate Reviews
Your reviewer opens the link, reads each test case, and marks each as **Approve** or **Reject**
with an optional comment. They click **Submit Review** when done.

### Step 5 — Upload
Back in the Review Modal, refresh to see the approval status.
- **Approved** (all tests approved) or **Partial** (some approved) → Upload button activates
- Click **Upload Approved** — each approved test is created in Zephyr, saved to KB,
  and a Jira comment is posted listing the new test keys

### Status meanings

| Status | Meaning |
|--------|---------|
| Pending | Awaiting teammate review |
| Approved | All tests approved — ready to upload |
| Partial | Some tests approved — partial upload available |
| Rejected | No tests approved |
| Uploaded | Upload complete — Zephyr keys shown |

---

## Dos and Don'ts

### Do

- **Do seed the KB before generating** — even a small KB dramatically improves test quality
  by giving Claude examples of your team's test style and naming conventions
- **Do provide a custom prompt for complex tickets** — if the Jira description is thin,
  add context like: "This feature handles PCI-scoped card data — focus on security and encryption"
- **Do edit test cases in the Review Modal** before sending for approval — generated output is
  a first draft; fix names, adjust priorities, and trim irrelevant steps
- **Do send the approval link to someone who knows the feature** — a domain-aware reviewer
  catches gaps that a general reviewer will miss
- **Do run `npm run kb` periodically** to clean up outdated or duplicate KB entries via the
  interactive CLI
- **Do filter by epic** (`JIRA_EPIC_KEY` in Config) when your project has many issues — this
  keeps the sidebar manageable and ensures KB context is scoped correctly
- **Do check the "Existing Zephyr Tests" panel** on the right before generating — if tests
  already cover the ticket well, you may only need to generate edge-case additions
- **Do use the 3-step EC2 test button** when setting up the database to isolate exactly where
  a connection problem is

### Don't

- **Don't upload without reviewing** — generated test cases are a starting point, not a final
  product; untested steps or vague expected results will pollute Zephyr
- **Don't set `KB_AUTO_DELETE_THRESHOLD` below 0.95** — at lower thresholds, legitimately
  different tests for similar features may be auto-deleted; use flagging (0.90+) for anything
  that needs human review
- **Don't commit `.env`, `approvals.json`, `local-kb-data/index.json`, or `ui-config.json`**
  — these are runtime files that contain credentials and live data; they are gitignored
- **Don't use the same Jira API token for both Jira and Confluence** if they are on different
  Atlassian sites — each site requires its own token
- **Don't run `npm run kb:migrate` while the app server is actively writing to the local KB**
  — the migration clears the pgvector KB first; run it during a quiet period
- **Don't switch AI providers mid-review** — the output format is consistent across providers,
  but switching mid-session will lose the current generation output
- **Don't rely on the KB alone for context** — the KB supplements Confluence and Jira context;
  if all three are empty the generated tests will be generic. Add detail to the Jira ticket first
- **Don't ignore the "Skipped X outdated entries" warning** in EC2 mode — it means similar
  test patterns exist but are flagged as outdated; review them in `npm run kb` to either restore
  or delete them
- **Don't mark all tests as "Partial" to bypass review** — partial approval uploads only the
  approved subset; use it intentionally when some tests genuinely need more work

---

## Limitations & Known Constraints

| Area | Constraint |
|------|-----------|
| Jira issue fetch | Max 30 issues per sidebar load |
| Confluence search | Max 5 pages, each truncated to ~1500 chars |
| Zephyr fetch | Max 500 existing tests per issue |
| Generation timeout | 5 minutes (Claude Code mode) |
| Embedding text limit | 8000 chars per document (content is truncated beyond this) |
| Zephyr objective field | 500 char limit — long test summaries are truncated |
| Local KB | All documents kept in memory; practical limit ~10,000 documents |
| pgvector KB | Scales to millions of documents (HNSW index) |
| Approval page refresh | Does not auto-update — manually refresh to see reviewer decisions |
| Zephyr product | Cloud only (Zephyr Scale); Server/Data Center not supported |
| AWS Bedrock KB | Config fields shown but not implemented |
