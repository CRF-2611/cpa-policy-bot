-- ── Stored tsvector column ────────────────────────────────────────────────────
--
-- Replaces the expression-based GIN index (to_tsvector computed per query)
-- with a column whose value is computed once at INSERT/UPDATE time.
-- Includes title so searches match document headings, not just body text.

ALTER TABLE policy_content
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(content, '')
    )
  ) STORED;

-- Index the stored column; drop the old expression index
CREATE INDEX IF NOT EXISTS policy_content_search_vector_idx
  ON policy_content USING GIN (search_vector);

DROP INDEX IF EXISTS policy_content_fts;


-- ── search_policy RPC ─────────────────────────────────────────────────────────
--
-- Single call replaces the client-side .textSearch() chain.
-- Returns ts_headline snippets computed in Postgres — no full content
-- crosses the wire. Results are ranked by relevance then recency.

CREATE OR REPLACE FUNCTION search_policy(
  p_query   text,
  p_sources text[]  DEFAULT NULL,
  p_limit   integer DEFAULT 10
)
RETURNS TABLE (
  id           uuid,
  source       text,
  title        text,
  snippet      text,
  url          text,
  last_updated timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT
    id,
    source,
    title,
    -- Strip the default <b>...</b> highlight markers; plain text is cleaner
    regexp_replace(
      ts_headline(
        'english',
        content,
        websearch_to_tsquery('english', p_query),
        'MaxFragments=2, MaxWords=50, MinWords=15, FragmentDelimiter=" … "'
      ),
      '</?b>',
      '',
      'g'
    ) AS snippet,
    url,
    last_updated
  FROM  policy_content
  WHERE search_vector @@ websearch_to_tsquery('english', p_query)
    AND (p_sources IS NULL OR source = ANY(p_sources))
  ORDER BY
    ts_rank(search_vector, websearch_to_tsquery('english', p_query)) DESC,
    last_updated DESC NULLS LAST
  LIMIT p_limit;
$$;
