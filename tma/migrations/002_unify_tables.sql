-- TMA Migration 002: Unify test_knowledge → kb_documents
-- Run this AFTER 001_duplicate_detection.sql.
-- Safe to run multiple times.

-- ── 1. Add duplicate-detection columns to kb_documents ───────────────────────
ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS outdated         boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outdated_reason  text,
  ADD COLUMN IF NOT EXISTS outdated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS duplicate_of     text        REFERENCES kb_documents(id) ON DELETE SET NULL;

-- ── 2. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_kb_outdated ON kb_documents (outdated);
CREATE INDEX IF NOT EXISTS idx_kb_sprint   ON kb_documents ((metadata->>'sprint'));

-- Replace IVFFlat with HNSW (no training rows needed, works on empty table)
DROP INDEX IF EXISTS kb_documents_embedding_idx;
CREATE INDEX IF NOT EXISTS idx_kb_embedding_hnsw
  ON kb_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── 3. Rebuild duplicate_log referencing kb_documents (TEXT id) ───────────────
DROP TABLE IF EXISTS duplicate_log;
CREATE TABLE duplicate_log (
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

-- ── 4. Migrate test_knowledge → kb_documents (if data exists) ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'test_knowledge') THEN
    INSERT INTO kb_documents (id, source, content, embedding, metadata, outdated, outdated_reason, outdated_at, created_at, updated_at)
    SELECT
      id::text,
      'generated',
      COALESCE(objective, title, ''),
      embedding,
      jsonb_build_object(
        'title',          title,
        'feature_area',   feature,
        'component',      component,
        'sprint',         sprint,
        'zephyr_key',     zephyr_key,
        'jira_issue_key', jira_key,
        'approved_by',    approved_by,
        'doc_type',       'test_case',
        'steps',          steps
      ),
      outdated,
      outdated_reason,
      outdated_at,
      created_at,
      updated_at
    FROM test_knowledge
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'Migrated % rows from test_knowledge to kb_documents',
      (SELECT COUNT(*) FROM test_knowledge);

    DROP TABLE test_knowledge CASCADE;
    RAISE NOTICE 'Dropped test_knowledge table';
  END IF;
END $$;

-- ── 5. find_duplicates() — now operates on kb_documents ──────────────────────
CREATE OR REPLACE FUNCTION find_duplicates(
  p_embedding  vector(1024),
  p_exclude_id text,
  p_threshold  numeric DEFAULT 0.90
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
  ORDER  BY similarity DESC
  LIMIT  10;
END;
$$ LANGUAGE plpgsql;

-- ── 6. stale_entries view ─────────────────────────────────────────────────────
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

-- ── 7. kb_stats view — unified (replaces both old versions) ───────────────────
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
