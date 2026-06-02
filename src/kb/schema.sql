-- src/kb/schema.sql
-- Run this in Supabase SQL Editor or any PostgreSQL instance
-- Requires pgvector extension (available on Supabase, Neon, RDS with pgvector)

-- 1. Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Main KB table
CREATE TABLE IF NOT EXISTS kb_documents (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('jira', 'zephyr', 'confluence', 'generated')),
  content     TEXT NOT NULL,
  embedding   vector(1024),          -- voyage-3 produces 1024-dimension vectors
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Vector similarity index (ivfflat — good for <1M docs, fast to build)
--    Switch to hnsw for >1M docs: CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
CREATE INDEX IF NOT EXISTS kb_documents_embedding_idx
  ON kb_documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Metadata indexes for filtering
CREATE INDEX IF NOT EXISTS kb_documents_source_idx
  ON kb_documents (source);

CREATE INDEX IF NOT EXISTS kb_documents_metadata_idx
  ON kb_documents USING GIN (metadata);

CREATE INDEX IF NOT EXISTS kb_documents_issue_key_idx
  ON kb_documents ((metadata->>'jira_issue_key'));

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

-- 6. Useful views
CREATE OR REPLACE VIEW kb_stats AS
SELECT
  source,
  COUNT(*)                                    AS doc_count,
  MAX(updated_at)                             AS last_updated,
  pg_size_pretty(pg_total_relation_size('kb_documents')) AS table_size
FROM kb_documents
GROUP BY source
ORDER BY doc_count DESC;

-- Done — verify with:
-- SELECT * FROM kb_stats;
-- SELECT COUNT(*) FROM kb_documents;

-- ─── Approvals table (replaces approvals.json) ───────────────────────────────
-- Survives server restarts, redeployments, and horizontal scaling.
-- Only created when DATABASE_URL is configured (Phase 2 mode).

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
