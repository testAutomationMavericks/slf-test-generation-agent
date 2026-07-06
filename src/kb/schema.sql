-- src/kb/schema.sql
-- Run this in Supabase SQL Editor or any PostgreSQL instance
-- Requires pgvector extension (available on Supabase, Neon, RDS with pgvector)

-- 1. Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Main KB table
CREATE TABLE IF NOT EXISTS kb_documents (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('jira', 'zephyr', 'confluence', 'generated')),
  content         TEXT NOT NULL,
  embedding       vector(1024),          -- voyage-3 produces 1024-dimension vectors
  metadata        JSONB DEFAULT '{}',
  outdated        boolean     NOT NULL DEFAULT false,
  outdated_reason text,
  outdated_at     timestamptz,
  duplicate_of    text        REFERENCES kb_documents(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns to existing table (no-ops if already present)
ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS outdated        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outdated_reason text,
  ADD COLUMN IF NOT EXISTS outdated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS duplicate_of   text        REFERENCES kb_documents(id) ON DELETE SET NULL;

-- 3. Vector similarity index (HNSW — no training rows needed, works on empty table)
DROP INDEX IF EXISTS kb_documents_embedding_idx;
CREATE INDEX IF NOT EXISTS idx_kb_embedding_hnsw
  ON kb_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Metadata indexes for filtering
CREATE INDEX IF NOT EXISTS kb_documents_source_idx
  ON kb_documents (source);

CREATE INDEX IF NOT EXISTS kb_documents_metadata_idx
  ON kb_documents USING GIN (metadata);

CREATE INDEX IF NOT EXISTS kb_documents_issue_key_idx
  ON kb_documents ((metadata->>'jira_issue_key'));

CREATE INDEX IF NOT EXISTS idx_kb_outdated     ON kb_documents (outdated);
CREATE INDEX IF NOT EXISTS idx_kb_sprint       ON kb_documents ((metadata->>'sprint'));
CREATE INDEX IF NOT EXISTS idx_kb_project_key  ON kb_documents ((metadata->>'project_key'));

-- 5. Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER kb_documents_updated_at
  BEFORE UPDATE ON kb_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 6. Duplicate log
CREATE TABLE IF NOT EXISTS duplicate_log (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  new_entry_id     text          REFERENCES kb_documents(id) ON DELETE CASCADE,
  old_entry_id     text,
  old_entry_title  text,
  similarity       numeric(5,4)  NOT NULL,
  action_taken     text          NOT NULL,   -- 'auto_deleted' | 'flagged'
  jira_notified    boolean       NOT NULL DEFAULT false,
  created_at       timestamptz   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_duplog_new ON duplicate_log (new_entry_id);

-- 7. find_duplicates function
--    p_project_key: when provided, only compares within the same project.
--                   Pass NULL to search across all projects.
CREATE OR REPLACE FUNCTION find_duplicates(
  p_embedding   vector(1024),
  p_exclude_id  text,
  p_threshold   numeric DEFAULT 0.90,
  p_project_key text    DEFAULT NULL
)
RETURNS TABLE (
  id          text,
  title       text,
  feature     text,
  sprint      text,
  zephyr_key  text,
  similarity  numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    kd.id,
    COALESCE(kd.metadata->>'title', kd.id)        AS title,
    kd.metadata->>'feature_area'                   AS feature,
    kd.metadata->>'sprint'                         AS sprint,
    kd.metadata->>'zephyr_key'                     AS zephyr_key,
    (1 - (kd.embedding <=> p_embedding))::numeric  AS similarity
  FROM   kb_documents kd
  WHERE  kd.id != p_exclude_id
    AND  (kd.outdated IS NULL OR kd.outdated = false)
    AND  (1 - (kd.embedding <=> p_embedding)) > p_threshold
    AND  (p_project_key IS NULL OR kd.metadata->>'project_key' = p_project_key)
  ORDER  BY similarity DESC
  LIMIT  10;
END;
$$ LANGUAGE plpgsql;

-- 8. Stale entries view
CREATE OR REPLACE VIEW stale_entries AS
SELECT
  id,
  COALESCE(metadata->>'title', id)  AS title,
  metadata->>'feature_area'         AS feature,
  metadata->>'sprint'               AS sprint,
  metadata->>'zephyr_key'           AS zephyr_key,
  updated_at,
  NOW() - updated_at                AS age,
  outdated,
  outdated_reason
FROM   kb_documents
WHERE  updated_at < NOW() - INTERVAL '90 days'
    OR outdated = true
ORDER  BY updated_at ASC;

-- 9. Unified KB stats view
CREATE OR REPLACE VIEW kb_stats AS
SELECT
  COUNT(*)                                                           AS total_entries,
  COUNT(*) FILTER (WHERE outdated IS NULL OR outdated = false)       AS active_entries,
  COUNT(*) FILTER (WHERE outdated = true)                            AS outdated_entries,
  COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))  AS added_this_month,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')   AS added_this_week,
  COUNT(DISTINCT metadata->>'feature_area')                          AS unique_features,
  COUNT(DISTINCT metadata->>'sprint')                                AS unique_sprints,
  MIN(created_at)                                                    AS oldest_entry,
  MAX(updated_at)                                                    AS last_updated
FROM kb_documents;

-- Done — verify with:
-- SELECT * FROM kb_stats;
-- SELECT COUNT(*) FROM kb_documents;

-- ─── Approvals table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  data         JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status);
CREATE INDEX IF NOT EXISTS approvals_created_idx ON approvals (created_at DESC);

CREATE OR REPLACE TRIGGER approvals_updated_at
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Verify:
-- SELECT id, status, created_at FROM approvals ORDER BY created_at DESC;
