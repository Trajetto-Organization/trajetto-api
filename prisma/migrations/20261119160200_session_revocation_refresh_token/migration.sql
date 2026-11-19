-- ----------------------------------------------------------------------------
-- Session revocation log: the refresh-token family (plano-escala F5-21)
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
-- A family ends when its live token goes: deleted (logout, a session
-- revoked, every session of the user, reuse detected, the user deleted) or
-- revoked without a successor. A rotation also sets revoked_at, but with
-- replaced_by_jti, and inserts the successor: no row, on purpose, or every
-- refresh would look like a revocation. Deleting a token already revoked
-- or expired (the nightly purge, the old links of a rotated family) is no
-- revocation either: the WHEN keeps the function out of those deletes.
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
      CREATE OR REPLACE TRIGGER "refresh_token_delete_session_revocation"
        AFTER DELETE ON "refresh_token"
        FOR EACH ROW
        WHEN (OLD."revoked_at" IS NULL AND OLD."expires_in" > (now() AT TIME ZONE 'UTC'))
        EXECUTE FUNCTION "trajetto_log_session_revocation"('refresh_family', 'family_id');

      CREATE OR REPLACE TRIGGER "refresh_token_revoke_session_revocation"
        AFTER UPDATE OF "revoked_at" ON "refresh_token"
        FOR EACH ROW
        WHEN (OLD."revoked_at" IS NULL
              AND NEW."revoked_at" IS NOT NULL
              AND NEW."replaced_by_jti" IS NULL)
        EXECUTE FUNCTION "trajetto_log_session_revocation"('refresh_family', 'family_id');

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
