-- ----------------------------------------------------------------------------
-- activity_part."businessId" -> "business" (plano-escala F2-18)
-- ----------------------------------------------------------------------------
-- One of the two foreign keys of the activity trail's partitioned shell, the
-- same definition as activity_businessId_fkey (ON DELETE SET NULL: the trail
-- outlives the company, with its name kept in tenantName), one per migration
-- (20261118140000_activity_part says why the shell).
--
-- Adding a foreign key takes SHARE ROW EXCLUSIVE on the table it references,
-- "business", until this migration commits. While it waits for that lock (an
-- open transaction that wrote "business"), every new write there queues
-- behind it:
--   a company's settings saved, a plan changed.
-- So each attempt waits one second longer than deadlock_timeout (2 s by
-- default, lock_timeout) and gives way for 1 s before the next one, up to
-- 30 attempts. Longer than deadlock_timeout because an autovacuum holding
-- the table is cancelled only by the waiter's deadlock check, at
-- deadlock_timeout: a lock_timeout of the same length fires in the same
-- wake-up, before the cancel, and no attempt would ever get the table from
-- a long autovacuum. A lock that never comes fails
-- the migration: the release step stops before the API, nothing of this
-- file stays, and `prisma migrate resolve --rolled-back` (docs/deploy.md,
-- P3009) lets the next run try again. The constraint is added only where
-- it is missing.
--
-- The shell is empty, so the check reads nothing: the lock is all it costs.
-- Each partition gets its clone of the key in the same statement. Expand
-- only: nothing reads or writes the shell before the copy window (F2-18).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attempt integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"activity_part"'::regclass
      AND conname = 'activity_part_businessId_fkey'
  ) THEN
    RETURN;
  END IF;

  PERFORM set_config(
    'lock_timeout',
    (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms',
    true
  );

  LOOP
    BEGIN
      ALTER TABLE "activity_part"
        ADD CONSTRAINT "activity_part_businessId_fkey"
        FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
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
