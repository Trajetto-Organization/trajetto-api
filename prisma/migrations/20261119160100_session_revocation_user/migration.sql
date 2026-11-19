-- ----------------------------------------------------------------------------
-- Session revocation log: the user (plano-escala F5-21)
-- ----------------------------------------------------------------------------
-- One row per subject into session_revocation_log, in the writer's
-- transaction (20261119160000_session_revocation_log has the why). Row
-- triggers, AFTER, each UPDATE one only on the columns it covers (UPDATE
-- OF) and only WHEN one of them really changed: every other write of the
-- table never calls the function. The list is
-- src/shared/auth/session-revocation.ts; the E2E
-- session-revocation-triggers holds the database to it.
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table until this
-- migration commits, which waits for the writes in flight and holds the
-- next ones: one table set per file, and the lock_timeout attempts of
-- 20261119130100_delivery_day_dirty_trigger. Expand: a rollback leaves the
-- triggers, which keep logging for an image that does not read the log.
--
-- The user's columns the session check reads, and the password, whose
-- change ends the other sessions; and the user deleted. Not last_seen_at,
-- the login counters or the preferences, which every session writes.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attempt integer := 0;
BEGIN
  PERFORM set_config(
    'lock_timeout',
    (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms',
    true
  );

  LOOP
    BEGIN
      CREATE OR REPLACE TRIGGER "user_session_revocation"
        AFTER UPDATE OF "password", "access_revoked", "role", "session_version", "businessId", "driverId", "profileAccessId", "anonymized_at" ON "user"
        FOR EACH ROW
        WHEN (OLD."password" IS DISTINCT FROM NEW."password"
           OR OLD."access_revoked" IS DISTINCT FROM NEW."access_revoked"
           OR OLD."role" IS DISTINCT FROM NEW."role"
           OR OLD."session_version" IS DISTINCT FROM NEW."session_version"
           OR OLD."businessId" IS DISTINCT FROM NEW."businessId"
           OR OLD."driverId" IS DISTINCT FROM NEW."driverId"
           OR OLD."profileAccessId" IS DISTINCT FROM NEW."profileAccessId"
           OR OLD."anonymized_at" IS DISTINCT FROM NEW."anonymized_at")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('user', 'id');

      CREATE OR REPLACE TRIGGER "user_delete_session_revocation"
        AFTER DELETE ON "user"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('user', 'id');

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;

      IF attempt >= 30 THEN
        RAISE;
      END IF;

      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
