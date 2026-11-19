-- ----------------------------------------------------------------------------
-- Session revocation log: the profile's permissions (plano-escala F5-21)
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
-- What a user of a profile may do is the profile's permission rows, which
-- the session loads: one added, changed or removed, and the profile
-- deleted, are logged as the profile.
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
      CREATE OR REPLACE TRIGGER "permission_insert_session_revocation"
        AFTER INSERT ON "permission"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('profile', 'profileAccessId');

      CREATE OR REPLACE TRIGGER "permission_session_revocation"
        AFTER UPDATE OF "permissionKey", "action", "canRead", "canWrite", "profileAccessId" ON "permission"
        FOR EACH ROW
        WHEN (OLD."permissionKey" IS DISTINCT FROM NEW."permissionKey"
           OR OLD."action" IS DISTINCT FROM NEW."action"
           OR OLD."canRead" IS DISTINCT FROM NEW."canRead"
           OR OLD."canWrite" IS DISTINCT FROM NEW."canWrite"
           OR OLD."profileAccessId" IS DISTINCT FROM NEW."profileAccessId")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('profile', 'profileAccessId');

      CREATE OR REPLACE TRIGGER "permission_delete_session_revocation"
        AFTER DELETE ON "permission"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('profile', 'profileAccessId');

      CREATE OR REPLACE TRIGGER "profile_access_delete_session_revocation"
        AFTER DELETE ON "profile_access"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('profile', 'id');

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
