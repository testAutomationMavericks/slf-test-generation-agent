# Selfridges Test Curator — User Guide

**Test Curator** is an AI-powered test case generation tool that reads your Jira tickets,
pulls in Confluence documentation and existing Zephyr tests, then generates comprehensive,
structured test cases ready for peer review and upload to Zephyr Scale.

---

## Table of Contents

1. [What Test Curator Can Do](#what-test-curator-can-do)
2. [What Test Curator Cannot Do](#what-test-curator-cannot-do)
3. [Console Page Walkthrough](#console-page-walkthrough)
4. [Generation Filters](#generation-filters)
5. [AI Providers](#ai-providers)
6. [Knowledge Base](#knowledge-base)
7. [Approval Workflow](#approval-workflow)
8. [Dos and Don'ts](#dos-and-donts)
9. [Limitations & Known Constraints](#limitations--known-constraints)

---

## What Test Curator Can Do

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

### Generation Filters
- Choose which **Priority levels** to generate: Critical, High, Medium, Low — any combination
- Choose which **Test types** to generate: Functional, Regression, Edge Case, Negative, Security
- Selections are saved automatically and persist across sessions
- Filters apply to auto-generation only; custom prompts and single-test updates are not constrained

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
- If any newly uploaded test is similar to an existing KB entry, a duplicate warning is
  appended to the comment (e.g. "QAP-T138 is 93% similar to QAP-T131 — older entry flagged")
- Saves uploaded tests to the Knowledge Base for future reuse

### Knowledge Base
- Stores approved test cases as vector embeddings for semantic search
- Uses Voyage-3 AI embeddings for high-accuracy semantic similarity search (requires Anthropic API key)
- Falls back to deterministic keyword/n-gram embeddings when no API key is set (no external calls)
- Automatic **duplicate detection**:
  - ≥ 97% similarity → older entry auto-deleted
  - ≥ 90% similarity → older entry flagged as outdated; Jira comment warns the uploader
  - All actions logged to `duplicate_log`
- **Zephyr sync on import**: when you import from Zephyr, KB entries whose Zephyr test case
  has since been deleted are automatically removed, keeping the two systems in sync
- `npm run kb` launches an interactive KB Manager CLI: search, flag, delete, purge, scan

### Header Status
- The header shows live connection chips for Jira, Confluence, Zephyr, Knowledge Base,
  and AI (with the active provider name shown, e.g. `AI: Claude Code`)
- Green chip = ready, red chip = not configured or unreachable
- Status refreshes automatically every 30 seconds

### Configuration (Config Tab)
- All credentials configurable in-browser (Jira, Confluence, Zephyr, AI provider, DB)
- 3-step EC2 connection test: host reachable → database accessible → schema ready
- Individual test buttons for Jira, Confluence, and Zephyr connections
- Changes take effect immediately (hot-swap) — no server restart needed

---

## What Test Curator Cannot Do

- **Does not modify Jira issues** except to post a comment after successful upload
- **Does not delete tests from Zephyr** — only manages KB entries; archive tests in Zephyr manually
- **Does not auto-approve** — a human must always review before upload
- **Does not generate tests without a Jira issue** as a starting point (though a custom prompt
  can work around thin ticket descriptions)
- **Does not support Zephyr Server/Data Center** — only Zephyr Scale (Cloud)
- **Does not run in your CI/CD pipeline** — it is a human-in-the-loop tool, not an automated runner

---

## Console Page Walkthrough

```
┌─ Issue Detail ──────────────────────────────────────────────────────────────┐
│  QAP-14  (bold amber)                                                        │
│  Filter option should have categories listed to select                       │
│  ### Custom Fields ... (description, scrollable)                             │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Toolbar ───────────────────────────────────────────────────────────────────┐
│  ⚡ Generate Tests   ↻ Update   ✕ Clear            ↑ Review & Upload        │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Filter Strip ──────────────────────────────────────────────────────────────┐
│  PRIORITY [Critical] [High] [Medium] [Low]  │  TYPE [Functional] ...  Claude Code │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Generate Tests** — runs auto-generation with the current filter selections
- **Update** — reviews the full Zephyr test suite for the issue and generates gap-filling updates
- **Clear** — wipes the output panel (does not affect Zephyr or the KB)
- **Review & Upload** — opens the Review Modal (only visible once output exists)
- **Filter strip** — Priority and Type toggles. Bright/bold = selected; muted/grey = deselected. Changes save immediately.
- **Engine badge** (right side of filter strip) — shows the active AI provider
- **KB badge** (right side of filter strip) — shows how many KB docs were used for context, after generation

The **Existing Zephyr Tests** panel on the right shows tests already linked to the selected issue.
Click **👁 View** to read a test, or **✏ Edit** to populate the prompt bar with that test's key
and update only that one test case.

---

## Generation Filters

Filters control what Claude generates. They apply **only to ⚡ Generate Tests** (auto-generation).
Custom prompts, ↻ Update, and ✏ Edit on a specific Zephyr test are not constrained by filters
so they can update exactly the test you intend.

### Priority
| Level | Use when |
|---|---|
| Critical | Core user journeys — failure = blocker |
| High | Important paths — failure = significant regression |
| Medium | Secondary paths, minor UX |
| Low | Edge cases, nice-to-have coverage |

### Type
| Type | What it covers |
|---|---|
| Functional | Feature works as described in acceptance criteria |
| Regression | Existing behaviour not broken |
| Edge Case | Boundary values, unusual inputs, extremes |
| Negative | Invalid inputs, error states, unauthorised access |
| Security | Auth, injection, data exposure |

---

## AI Providers

Switch providers in **Config tab → AI Provider**.

| Provider | Best For | Requires |
|----------|----------|----------|
| **Claude Code** (recommended) | Best output quality; uses your local Claude CLI | Claude Code CLI installed |
| **Anthropic API** | Cloud-based, no CLI needed | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-4o alternative | `OPENAI_API_KEY` |
| **Local (Ollama etc.)** | Fully offline, no cost | Local model server running |

The active provider is shown in the `AI: <name>` chip in the header and in the engine badge on the filter strip.

---

## Knowledge Base

The KB stores approved, uploaded test cases so future generations benefit from your team's
accumulated test patterns.

### When it is used
- **During generation:** Top-K semantically similar past tests are injected into the prompt
  as examples, improving consistency and coverage. The KB badge shows how many docs were used.
- **After upload:** Each uploaded test is automatically saved to the KB

### Backend

**pgvector (DATABASE_URL configured)**
- Stored in PostgreSQL with pgvector extension
- Uses Voyage-3 AI embeddings (1024 dimensions) when `ANTHROPIC_API_KEY` is set
- Falls back to deterministic keyword/n-gram embedding when no API key is present
- Full duplicate detection with auto-delete and flagging
- Shared across the whole team

### Zephyr sync

When you click **Import from Zephyr** on the KB tab, the importer:
1. Fetches all live test cases from Zephyr for the project
2. Skips any whose key already appears in a KB document (whether imported directly or generated
   from an approval — e.g. `zephyr:QAP-T131` or `generated:QAP-T131:QAP-12` are both skipped)
3. **Removes stale entries** — any `zephyr:` KB document whose test case no longer exists in
   Zephyr is deleted automatically. This covers the case where you delete a test in Zephyr and
   want the KB to reflect that change.

---

## Approval Workflow

```
Generate → Review & Edit → Send for Approval → Teammate Reviews → Upload to Zephyr
```

### Step 1 — Generate
Select a Jira issue from the sidebar, set your Priority/Type filters, and click **Generate Tests**.
Wait for the output (Claude Code: 1–3 min; Anthropic API: 30–90s).

### Step 2 — Review & Edit
Click **Review & Upload** to open the Review Modal.
- Navigate test cases using ‹ / › or numbered thumbnails
- Edit any field: name, priority, type, preconditions, full content
- Untick the checkbox to exclude a test from the approval batch
- Set the **Zephyr folder** name (default: "Generated")

### Step 3 — Send for Approval
Click **Send for Approval**, enter your name, and confirm.
- A shareable URL is generated and copied to your clipboard
- Send this link to your reviewer — no login required

### Step 4 — Teammate Reviews
Your reviewer opens the link, reads each test case, and marks each as **Approve** or **Reject**
with an optional comment. They click **Submit Review** when done.

### Step 5 — Upload
Back in the Review Modal, refresh to see the approval status.
- **Approved** or **Partial** → Upload button activates
- Click **Upload Approved** — each approved test is created in Zephyr, saved to KB,
  and a Jira comment is posted listing the new test keys
- If any newly uploaded test is similar to an existing KB entry, the Jira comment includes
  a duplicate warning so you can review whether the older test should be retired

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
  by giving Claude examples of your team's test style
- **Do set Priority/Type filters before generating** — targeting Critical + Functional only
  produces a focused, reviewable set rather than an overwhelming batch
- **Do provide a custom prompt for complex tickets** — if the Jira description is thin,
  add context: "This feature handles PCI-scoped card data — focus on security and encryption"
- **Do edit test cases in the Review Modal** before sending for approval — generated output
  is a first draft; fix names, adjust priorities, and trim irrelevant steps
- **Do send the approval link to someone who knows the feature** — domain-aware reviewers
  catch gaps a general reviewer will miss
- **Do run `npm run kb` periodically** to clean up outdated or duplicate KB entries
- **Do filter by epic** (`JIRA_EPIC_KEY` in Config) when your project has many issues
- **Do check the Existing Zephyr Tests panel** before generating — if tests already cover
  the ticket well, you may only need edge-case additions
- **Do run Import from Zephyr** after deleting tests in Zephyr — this cleans the corresponding
  KB entries automatically

### Don't

- **Don't upload without reviewing** — generated test cases are a starting point; untested steps
  or vague expected results will pollute Zephyr
- **Don't set `KB_AUTO_DELETE_THRESHOLD` below 0.95** — lower thresholds can auto-delete
  legitimately different tests for similar features; use flagging (0.90+) for anything needing review
- **Don't commit `.env`, `approvals.json`, or `ui-config.json`** — these contain credentials
  and live data and are gitignored
- **Don't run `npm run kb:migrate` while the app server is actively writing** — run during
  a quiet period
- **Don't switch AI providers mid-review** — switching mid-session will lose current output
- **Don't rely on the KB alone for context** — the KB supplements Confluence and Jira context;
  if all three are empty the generated tests will be generic
- **Don't ignore duplicate warnings in Jira comments** — they mean a newly uploaded test
  closely matches an older one; review whether the old test should be retired from Zephyr

---

## Limitations & Known Constraints

| Area | Constraint |
|------|-----------|
| Jira issue fetch | Max 30 issues per sidebar load |
| Confluence search | Max 5 pages, each truncated to ~1500 chars |
| Zephyr fetch | Max 500 existing tests per issue |
| Generation timeout | 5 minutes (Claude Code mode) |
| Embedding text limit | 8000 chars per document |
| Zephyr objective field | 500 char limit — long summaries are truncated |
| pgvector KB | Scales to millions of documents (HNSW index) |
| Approval page refresh | Does not auto-update — refresh manually to see reviewer decisions |
| Zephyr product | Cloud only (Zephyr Scale); Server/Data Center not supported |
