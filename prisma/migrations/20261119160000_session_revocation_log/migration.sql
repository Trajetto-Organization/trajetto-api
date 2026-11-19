-- ----------------------------------------------------------------------------
-- The session revocation log (plano-escala F5-21)
-- ----------------------------------------------------------------------------
-- What ends or narrows a session is a write to one of the columns the
-- session check reads (ensureAuthenticated, the socket's handshake and its
-- sweep): the user's password, access, role, session version, company,
-- driver and profile; the company's and the branch's `is_active` and the
-- company's modules; the driver's status, company and branch; the
-- profile's permissions; and a refresh-token family revoked. Today each
-- process learns of it only by reading the session again (every request,
-- and every SOCKET_REVALIDATE_MS for a socket) or by a frame on the Redis
-- adapter, which is at most once and absent for a change made by SQL.
--
-- From here, triggers on those columns (the next migrations, one table
-- set per file) write one row per subject into this table, in the same
-- transaction as the change: (kind, subject_id) says whose sessions to
-- look at again, never what changed. The revocation feed (F5-22) reads it
-- every second from the last id it saw; the sockets (F5-24) and the
-- session cache (F5-23) act on it. A normal refresh rotation writes
-- nothing. src/shared/auth/session-revocation.ts lists each trigger with
-- the columns it covers, and tests/E2E/session-revocation-triggers.test.ts
-- holds the database to that list.
--
-- `at` is UTC, as every timestamp here: the trigger writes
-- now() AT TIME ZONE 'UTC'. Kept 7 days (the nightly refresh-token purge
-- deletes older rows): a process that missed more than that has nothing
-- of its own left to revoke.
--
-- One function for every trigger: the kind and the column that names the
-- subject come as arguments, and an UPDATE that moves the subject (a
-- permission moved to another profile) logs both. It runs with the rights
-- of whoever wrote the row: the runtime roles' group has DML on every table
-- and USAGE on the sequences (infra/sql/20-runtime-roles.sql), the same
-- grant for a table made after it. It names its table with the schema the
-- migration runs in and pins search_path, as every function here.
--
-- Expand: a new table and a function nothing calls yet. The image of
-- before never reads it; a rollback leaves both, and the triggers keep
-- writing for the older image, which ignores the rows.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "session_revocation_log" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_revocation_log_pkey" PRIMARY KEY ("id")
);

-- The retention's walk, oldest first.
CREATE INDEX IF NOT EXISTS "session_revocation_log_at_idx"
  ON "session_revocation_log"("at");

DO $migration$
BEGIN
  EXECUTE format(
    $ddl$
CREATE OR REPLACE FUNCTION %1$I."trajetto_log_session_revocation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  old_subject text;
  new_subject text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_subject := to_jsonb(OLD) ->> TG_ARGV[1];
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_subject := to_jsonb(NEW) ->> TG_ARGV[1];
  END IF;

  INSERT INTO %1$I."session_revocation_log" ("kind", "subject_id", "at")
  SELECT DISTINCT TG_ARGV[0], subject, now() AT TIME ZONE 'UTC'
  FROM unnest(ARRAY[old_subject, new_subject]) AS subject
  WHERE subject IS NOT NULL;

  RETURN NULL;
END;
$fn$
$ddl$,
    current_schema()
  );
END
$migration$;
