-- ----------------------------------------------------------------------------
-- Whether every live process can run beside a contraction (plano-escala
-- F5-07, D20)
-- ----------------------------------------------------------------------------
-- A contraction (the queues' foreign keys and uniques dropped, F5-06; the
-- queues swapped for partitioned tables, F5-09; an index the old code
-- needed, F2-21b) breaks an image that still leans on what it removes. Such
-- an image keeps serving during a rolling deploy, and comes back with a
-- rollback; the plan ships in one release, so the image before it is the
-- one from before the plan. So each contraction is a step of this folder
-- that asks the functions below first, and stays 'pending' until they say
-- yes; the next deploy, or a force_release, runs it again.
--
-- trajetto_capability_ready(capability, window) is true when:
--
--   - the database has no company at all: a new one (the E2E template,
--     `yarn dev` from scratch, an environment before its first sign-up),
--     with nothing to protect; or
--   - no session in this database is unnamed, AND every process that wrote
--     an ops_sample row in the window announced the capability in its
--     newest one, and at least one did.
--
-- Why the unnamed sessions. A process announces what it can run in the
-- `capabilities` of its per-minute ops_sample row
-- (src/shared/health/capabilities.ts). The image from before the plan
-- writes no such row: alone it would be invisible, and an empty window
-- would read as "everybody agrees". But it is also the only one whose
-- sessions carry no application_name: every pool of this build names its
-- own (src/shared/database/pg-driver.ts, "trajetto-api"), as do the release
-- step's and the partition job's sessions, psql and pg_dump. An unnamed
-- client session in this database is read as that image, and holds the
-- contraction back. Its pools keep an idle connection for 5 min, and its
-- workers poll every few seconds, so a live one is seen. A role that cannot
-- read another session's backend_type (it needs pg_read_all_stats) counts
-- every unnamed session, the cautious answer.
--
-- trajetto_queue_swap_ready(window) is the queues' one: the capability
-- queue-partition-agnostic-v1 (nothing reads or writes the four queues
-- through a foreign key, a cascade or a unique besides the primary key).
--
-- Both are replaced on every release when their text changed, owned by the
-- migration user and not callable by anybody else (they only read, but the
-- runtime has no business asking). Timestamps: ops_sample.ts holds UTC
-- without a zone, compared here in UTC whatever the session's zone.
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  before_text text;
  after_text text;
BEGIN
  SELECT string_agg(p.prosrc, E'\n' ORDER BY p.proname)
  INTO before_text
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = current_schema()::regnamespace
    AND p.proname IN ('trajetto_capability_ready', 'trajetto_queue_swap_ready');

  CREATE OR REPLACE FUNCTION trajetto_capability_ready(
    capability text,
    sample_window interval
  )
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path FROM CURRENT
  AS $fn$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM "business") THEN
      RETURN true;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_catalog.pg_backend_pid()
        AND coalesce(a.backend_type, 'client backend') = 'client backend'
        AND coalesce(a.application_name, '') = ''
    ) THEN
      RETURN false;
    END IF;

    RETURN coalesce((
      SELECT bool_and(coalesce(latest.metrics -> 'capabilities' ? capability, false))
      FROM (
        SELECT DISTINCT ON (s."replica") s."metrics"
        FROM "ops_sample" s
        WHERE s."ts" >= (now() AT TIME ZONE 'UTC') - sample_window
          AND s."role" <> 'cluster'
        ORDER BY s."replica", s."ts" DESC
      ) latest
    ), false);
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION trajetto_queue_swap_ready(sample_window interval)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path FROM CURRENT
  AS $fn$
    SELECT trajetto_capability_ready('queue-partition-agnostic-v1', sample_window)
  $fn$;

  REVOKE ALL ON FUNCTION trajetto_capability_ready(text, interval) FROM PUBLIC;
  REVOKE ALL ON FUNCTION trajetto_queue_swap_ready(interval) FROM PUBLIC;

  SELECT string_agg(p.prosrc, E'\n' ORDER BY p.proname)
  INTO after_text
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = current_schema()::regnamespace
    AND p.proname IN ('trajetto_capability_ready', 'trajetto_queue_swap_ready');

  IF before_text IS NOT DISTINCT FROM after_text THEN
    RAISE NOTICE 'skipped: trajetto_capability_ready e trajetto_queue_swap_ready já estavam assim';
  ELSE
    RAISE NOTICE 'applied: trajetto_capability_ready e trajetto_queue_swap_ready (re)criadas';
  END IF;
END
$step$;
