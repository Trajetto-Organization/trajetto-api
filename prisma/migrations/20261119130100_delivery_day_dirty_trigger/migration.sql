-- ----------------------------------------------------------------------------
-- A delivery that changes status or is deleted marks its day dirty
-- (plano-escala F4-20, decision D52)
-- ----------------------------------------------------------------------------
-- The rollup of F4-21 counts each closed day once. A day changes after
-- that only when one of its deliveries does: deleted (an import reversal,
-- the purge of a company, the cascade of a company deleted by hand) or,
-- for a count by status, its status changed. Each of those writes the
-- delivery's day into tenant_day_dirty (previous migration), and the job
-- counts it again within one run, 15 min, whatever the day's age: decision
-- D52's "an old deletion shows within 15 min".
--
-- The day is the UTC day of the old row's created_at: the column the
-- dashboard groups by (dashboard-repository.ts), read without the company's
-- zone, which would be a read per row. The job counts again every civil day
-- that overlaps it, in the company's zone and in the platform's.
--
-- One function and two triggers, AFTER and FOR EACH ROW:
--
--  - UPDATE OF status, only WHEN the status really changed: the other
--    updates of a delivery (the geocoder, the proof's address, the route)
--    never call the function, and a status written unchanged neither;
--  - DELETE. The WHEN of a DELETE trigger cannot read NEW, hence two.
--
-- What it costs a writer: one probe of tenant_day_dirty's index per
-- changed row, and an INSERT only when the day is not marked yet, about
-- once per company and day per run of the job. No unique key, on purpose:
-- an INSERT under one waits for the open transaction that inserted the
-- same day first, and two transactions marking two days in opposite orders
-- (two route starts, a reversal) would deadlock. Without it nothing ever
-- waits; two writers that both find the day unmarked leave two rows, which
-- the job reads as one day. A writer that found the day marked adds
-- nothing, so the job takes a mark away BEFORE it counts the day, and
-- counts only after every transaction open at that moment has ended.
-- The HTTP's statement budgets count what Prisma sends, not this; a
-- pg_stat_statements with track = all (the load harness) does count it.
--
-- The INSERT runs with the rights of whoever wrote the delivery: the
-- runtime roles' group, trajetto_app, has DML on every table and USAGE on
-- the sequences (infra/sql/20-runtime-roles.sql), the same grant for a
-- table made after it. The function names its table with the schema the
-- migration runs in and pins search_path, as every function here. A bulk
-- loader turns the triggers off for its session with
-- session_replication_role = replica, as the load seed does.
--
-- Expand: a function and two triggers. CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on "delivery", the hottest table, until this migration
-- commits, so it is alone in this file, with the attempts of
-- 20261118140100_activity_part_business_fk. The serving image's writes mark
-- days from then on, and a rollback leaves the triggers, which keep
-- marking for the older image.
-- ----------------------------------------------------------------------------

DO $migration$
BEGIN
  EXECUTE format(
    $ddl$
CREATE OR REPLACE FUNCTION %1$I."trajetto_mark_tenant_day_dirty"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  INSERT INTO %1$I."tenant_day_dirty" ("businessId", "day", "marked_at")
  SELECT OLD."businessId", OLD."created_at"::date, now() AT TIME ZONE 'UTC'
  WHERE NOT EXISTS (
    SELECT 1 FROM %1$I."tenant_day_dirty" AS marked
    WHERE marked."businessId" = OLD."businessId"
      AND marked."day" = OLD."created_at"::date
  );

  RETURN NULL;
END;
$fn$
$ddl$,
    current_schema()
  );
END
$migration$;

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
      CREATE OR REPLACE TRIGGER "delivery_status_marks_day_dirty"
        AFTER UPDATE OF "status" ON "delivery"
        FOR EACH ROW
        WHEN (OLD."status" IS DISTINCT FROM NEW."status")
        EXECUTE FUNCTION "trajetto_mark_tenant_day_dirty"();

      CREATE OR REPLACE TRIGGER "delivery_delete_marks_day_dirty"
        AFTER DELETE ON "delivery"
        FOR EACH ROW
        EXECUTE FUNCTION "trajetto_mark_tenant_day_dirty"();

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
