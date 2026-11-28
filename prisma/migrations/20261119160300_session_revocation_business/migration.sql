-- ----------------------------------------------------------------------------
-- Session revocation log: the company and its modules (plano-escala F5-21)
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
-- A company deactivated or deleted ends its sessions; a module switched
-- off changes what every one of them may do (the module gate reads the
-- entitlements the session loaded). Both are logged as the company.
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
      CREATE OR REPLACE TRIGGER "business_session_revocation"
        AFTER UPDATE OF "is_active" ON "business"
        FOR EACH ROW
        WHEN (OLD."is_active" IS DISTINCT FROM NEW."is_active")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('business', 'id');

      CREATE OR REPLACE TRIGGER "business_delete_session_revocation"
        AFTER DELETE ON "business"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('business', 'id');

      CREATE OR REPLACE TRIGGER "business_entitlement_insert_session_revocation"
        AFTER INSERT ON "business_entitlement"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('business', 'businessId');

      CREATE OR REPLACE TRIGGER "business_entitlement_session_revocation"
        AFTER UPDATE OF "enabled", "module", "businessId" ON "business_entitlement"
        FOR EACH ROW
        WHEN (OLD."enabled" IS DISTINCT FROM NEW."enabled"
           OR OLD."module" IS DISTINCT FROM NEW."module"
           OR OLD."businessId" IS DISTINCT FROM NEW."businessId")
        EXECUTE FUNCTION "trajetto_log_session_revocation"('business', 'businessId');

      CREATE OR REPLACE TRIGGER "business_entitlement_delete_session_revocation"
        AFTER DELETE ON "business_entitlement"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_log_session_revocation"('business', 'businessId');

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
