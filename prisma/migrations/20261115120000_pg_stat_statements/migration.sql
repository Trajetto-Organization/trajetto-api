-- ----------------------------------------------------------------------------
-- pg_stat_statements: what each query costs (plano-escala F1, item F1-05)
-- ----------------------------------------------------------------------------
-- The scale plan decides from measured cost, not from opinion: the hourly
-- snapshot of the top statements (pgss_snapshot) and the database metrics
-- read this extension. It is per database, so it comes from a migration like
-- pg_trgm did, and every E2E database cloned from the template has it too.
--
-- Additive and idempotent: IF NOT EXISTS, and nothing the serving release
-- reads changes.
--
-- Tolerant on purpose. pg_stat_statements is not a trusted extension: only
-- a superuser can create it. The release step runs with the Database's own
-- user, a superuser on the Dokploy image, but a migration that failed for a
-- missing privilege would block the whole release for a measurement. So the
-- creation sits in a DO block that gives up quietly when the user cannot
-- create it, or when the server has no contrib files; the state then reads
-- "missing" (src/shared/health/pg-stat-statements-state.ts), never an error.
--
-- Creating the extension does not start the measuring: the server must also
-- preload the library (shared_preload_libraries), which today's production
-- image does not. Until the new image (wave 3) the state is "not_loaded" and
-- everything that reads the view skips it with a notice.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_stat_statements not created (%): the state reads missing', SQLERRM;
END
$$;
