-- TMA Knowledge Base — duplicate detection migration
-- Run this against your EC2 PostgreSQL database.
-- Safe to run multiple times (uses IF NOT EXISTS / OR REPLACE throughout).

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Base table (skip if it already exists) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_knowledge (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text          NOT NULL,
  objective     text,
  feature       text,
  component     text,
  sprint        text,
  test_type     text          DEFAULT 'functional',
  jira_key      text,
  zephyr_key    text,
  steps         jsonb         DEFAULT '[]',
  tags          text[]        DEFAULT '{}',
  embedding     vector(1024),
  approved_by   text,
  approved_at   timestamptz,
  outdated      boolean       NOT NULL DEFAULT false,
  outdated_reason text,
  outdated_at   timestamptz,
  duplicate_of  uuid          REFERENCES test_knowledge(id) ON DELETE SET NULL,
  created_at    timestamptz   NOT NULL DEFAULT NOW(),
  updated_at    timestamptz   NOT NULL DEFAULT NOW()
);

-- ── Add columns to existing table (no-ops if already present) ─────────────────
ALTER TABLE test_knowledge
  ADD COLUMN IF NOT EXISTS outdated         boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outdated_reason  text,
  ADD COLUMN IF NOT EXISTS outdated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS duplicate_of     uuid        REFERENCES test_knowledge(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sprint           text,
  ADD COLUMN IF NOT EXISTS zephyr_key       text,
  ADD COLUMN IF NOT EXISTS approved_by      text,
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT NOW();

-- ── Duplicate log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS duplicate_log (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  new_entry_id     uuid          REFERENCES test_knowledge(id) ON DELETE CASCADE,
  old_entry_id     uuid,
  old_entry_title  text,
  similarity       numeric(5,4)  NOT NULL,
  action_taken     text          NOT NULL,   -- 'auto_deleted' | 'flagged'
  jira_notified    boolean       NOT NULL DEFAULT false,
  created_at       timestamptz   NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- HNSW: no training data needed (unlike IVFFlat which requires ≥ lists rows)
CREATE INDEX IF NOT EXISTS idx_tk_embedding_hnsw
  ON test_knowledge
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_tk_outdated ON test_knowledge (outdated);
CREATE INDEX IF NOT EXISTS idx_tk_sprint   ON test_knowledge (sprint);
CREATE INDEX IF NOT EXISTS idx_duplog_new  ON duplicate_log (new_entry_id);

-- ── Stale entries view ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW stale_entries AS
SELECT
  id, title, feature, sprint, zephyr_key,
  updated_at, NOW() - updated_at AS age,
  outdated, outdated_reason
FROM   test_knowledge
WHERE  updated_at < NOW() - INTERVAL '90 days'
    OR outdated = true
ORDER  BY updated_at ASC;

-- ── KB stats view (used by manage.js → View KB stats) ─────────────────────────
CREATE OR REPLACE VIEW kb_stats AS
SELECT
  COUNT(*)                                                    AS total_entries,
  COUNT(*) FILTER (WHERE outdated = false)                    AS active_entries,
  COUNT(*) FILTER (WHERE outdated = true)                     AS outdated_entries,
  COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS added_this_month,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS added_this_week,
  COUNT(DISTINCT feature)                                     AS unique_features,
  COUNT(DISTINCT sprint)                                      AS unique_sprints,
  MIN(created_at)                                             AS oldest_entry,
  MAX(updated_at)                                             AS last_updated
FROM test_knowledge;

-- ── find_duplicates function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION find_duplicates(
  p_embedding  vector(1024),
  p_exclude_id uuid,
  p_threshold  numeric DEFAULT 0.90
)
RETURNS TABLE (
  id          uuid,
  title       text,
  feature     text,
  sprint      text,
  zephyr_key  text,
  similarity  numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    tk.id,
    tk.title,
    tk.feature,
    tk.sprint,
    tk.zephyr_key,
    (1 - (tk.embedding <=> p_embedding))::numeric
  FROM   test_knowledge tk
  WHERE  tk.id      != p_exclude_id
    AND  tk.outdated = false
    AND  (1 - (tk.embedding <=> p_embedding)) > p_threshold
  ORDER  BY similarity DESC
  LIMIT  10;
END;
$$ LANGUAGE plpgsql;
