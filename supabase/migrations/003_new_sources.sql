-- Extend the source CHECK constraints to cover the three new sync sources.
-- Uses a DO block to safely drop the auto-named constraint regardless of its
-- generated name, then re-adds it as a named constraint.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'policy_content'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%notion%'
  LOOP
    EXECUTE format('ALTER TABLE policy_content DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE policy_content
  ADD CONSTRAINT policy_content_source_check
  CHECK (source IN (
    'notion', 'gdrive', 'hansard', 'written_questions',
    'manifesto', 'rolling_top_lines', 'policy_papers'
  ));


DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'sync_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%notion%'
  LOOP
    EXECUTE format('ALTER TABLE sync_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE sync_log
  ADD CONSTRAINT sync_log_source_check
  CHECK (source IN (
    'notion', 'gdrive', 'hansard', 'written_questions',
    'manifesto', 'rolling_top_lines', 'policy_papers'
  ));
