-- ----------------------------------------------------------------------------
-- delivery_event_part."deliveryId" -> "delivery" (plano-escala F2-16)
-- ----------------------------------------------------------------------------
-- One of the six foreign keys of the delivery trail's partitioned shell, the
-- same definition as delivery_event_deliveryId_fkey (ON DELETE CASCADE), one
-- per migration (20261117200000_delivery_event_part says why the shell).
--
-- Adding a foreign key takes SHARE ROW EXCLUSIVE on the table it references,
-- "delivery", until this migration commits. While it waits for that lock (an
-- open transaction that wrote "delivery"), every new write there queues
-- behind it:
--   every change of a delivery.
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
-- only: nothing reads or writes the shell before the copy window (F2-17).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attempt integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"delivery_event_part"'::regclass
      AND conname = 'delivery_event_part_deliveryId_fkey'
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
      ALTER TABLE "delivery_event_part"
        ADD CONSTRAINT "delivery_event_part_deliveryId_fkey"
        FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
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
