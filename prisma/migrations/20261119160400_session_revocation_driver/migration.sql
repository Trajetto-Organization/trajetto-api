-- ----------------------------------------------------------------------------
-- Session revocation log: the driver and the branch (plano-escala F5-21)
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
-- A driver's session needs the driver ACTIVE, in the user's company, and
-- its branch active: the driver's status, company and branch, the driver
-- deleted, and the branch deactivated or deleted.
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
      CREATE OR REPLACE TRIGGER "driver_session_revocation"
        AFTER UPDATE OF "status", "businessId", "branchId" ON "driver"
        FOR EACH ROW
        WHEN (OLD."status" IS DISTINCT FROM NEW."status"
           OR OLD."businessId" IS DISTINCT FROM NEW."businessId"
           OR OLD."branchId" IS DISTINCT FROM NEW."branchId")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('driver', 'id');

      CREATE OR REPLACE TRIGGER "driver_delete_session_revocation"
        AFTER DELETE ON "driver"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('driver', 'id');

      CREATE OR REPLACE TRIGGER "branch_session_revocation"
        AFTER UPDATE OF "is_active" ON "branch"
        FOR EACH ROW
        WHEN (OLD."is_active" IS DISTINCT FROM NEW."is_active")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('branch', 'id');

      CREATE OR REPLACE TRIGGER "branch_delete_session_revocation"
        AFTER DELETE ON "branch"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('branch', 'id');

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
