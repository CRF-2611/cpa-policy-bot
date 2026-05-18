-- Track which MP office each session belongs to, powering history sidebar + analytics dashboard.

CREATE TABLE IF NOT EXISTS sessions (
  session_id    text        PRIMARY KEY,
  office        text        NOT NULL DEFAULT '',
  first_message text        NOT NULL DEFAULT '',
  created_at    timestamptz DEFAULT now(),
  last_active   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_office_idx      ON sessions (office);
CREATE INDEX IF NOT EXISTS sessions_created_at_idx  ON sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_last_active_idx ON sessions (last_active DESC);

-- Upsert a session record: inserts on first message, updates last_active + office on subsequent calls.
-- first_message is preserved from the initial insert and never overwritten.
CREATE OR REPLACE FUNCTION upsert_session(
  p_session_id  text,
  p_office      text,
  p_first_msg   text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO sessions (session_id, office, first_message)
  VALUES (p_session_id, p_office, p_first_msg)
  ON CONFLICT (session_id) DO UPDATE SET
    last_active = now(),
    office      = CASE WHEN EXCLUDED.office != '' THEN EXCLUDED.office ELSE sessions.office END;
$$;

-- Analytics: session count grouped by office
CREATE OR REPLACE FUNCTION analytics_by_office()
RETURNS TABLE (office text, session_count bigint, last_active timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT office, COUNT(*) AS session_count, MAX(last_active) AS last_active
  FROM sessions
  WHERE office != ''
  GROUP BY office
  ORDER BY session_count DESC;
$$;

-- Analytics: daily session volume for the last N days
CREATE OR REPLACE FUNCTION analytics_daily_volume(p_days integer DEFAULT 30)
RETURNS TABLE (day date, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*) AS count
  FROM sessions
  WHERE created_at > now() - (p_days || ' days')::interval
  GROUP BY DATE(created_at AT TIME ZONE 'UTC')
  ORDER BY day;
$$;
