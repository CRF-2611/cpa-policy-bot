-- Stores synced policy content from all sources
CREATE TABLE IF NOT EXISTS policy_content (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT        NOT NULL CHECK (source IN ('notion', 'gdrive', 'hansard', 'written_questions')),
  source_id    TEXT        NOT NULL,
  title        TEXT        NOT NULL DEFAULT '',
  content      TEXT        NOT NULL DEFAULT '',
  url          TEXT,
  last_updated TIMESTAMPTZ,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB       NOT NULL DEFAULT '{}',

  CONSTRAINT policy_content_source_id_unique UNIQUE (source, source_id)
);

-- Full-text search on content (used by .textSearch('content', ...))
CREATE INDEX IF NOT EXISTS policy_content_fts
  ON policy_content USING gin(to_tsvector('english', content));

-- Efficient filtering by source + recency
CREATE INDEX IF NOT EXISTS policy_content_source_last_updated
  ON policy_content (source, last_updated DESC);


-- Tracks when each source was last synced
CREATE TABLE IF NOT EXISTS sync_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT        NOT NULL CHECK (source IN ('notion', 'gdrive', 'hansard', 'written_questions')),
  last_sync_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT        NOT NULL CHECK (status IN ('success', 'error', 'in_progress')),
  records_updated INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sync_log_source
  ON sync_log (source, last_sync_at DESC);


-- Stores chat session history
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT        NOT NULL,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_session_id
  ON conversations (session_id, created_at ASC);


-- Row-level security: service role bypasses RLS; anon/authenticated get read-only access
ALTER TABLE policy_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_policy_content" ON policy_content FOR SELECT USING (true);
CREATE POLICY "read_sync_log"       ON sync_log       FOR SELECT USING (true);
CREATE POLICY "read_conversations"  ON conversations  FOR SELECT USING (true);
