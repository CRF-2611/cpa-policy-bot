-- Log which Notion topics are accessed per session, powering the topic analytics chart.
-- topic is extracted from the Notion page title, e.g. "Water — Lines to Take" → "Water"

CREATE TABLE IF NOT EXISTS topic_log (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text        NOT NULL,
  topic      text        NOT NULL,
  logged_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topic_log_session_idx ON topic_log (session_id);
CREATE INDEX IF NOT EXISTS topic_log_topic_idx   ON topic_log (topic);
CREATE INDEX IF NOT EXISTS topic_log_logged_at   ON topic_log (logged_at DESC);

-- Analytics: top topics over the last N days
CREATE OR REPLACE FUNCTION analytics_by_topic(p_days integer DEFAULT 30)
RETURNS TABLE (topic text, query_count bigint, last_seen timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT topic, COUNT(DISTINCT session_id) AS query_count, MAX(logged_at) AS last_seen
  FROM topic_log
  WHERE logged_at > now() - (p_days || ' days')::interval
  GROUP BY topic
  ORDER BY query_count DESC
  LIMIT 20;
$$;
