-- ----------------------------------------------------------------------------
-- delivery_event_part."apiKeyId" -> "api_key" (plano-escala F2-16)
-- ----------------------------------------------------------------------------
-- One of the six foreign keys of the delivery trail's partitioned shell, the
-- same definition as delivery_event_apiKeyId_fkey (ON DELETE SET NULL), one
-- per migration (20261117200000_delivery_event_part says why the shell).
--
-- Adding a foreign key takes SHARE ROW EXCLUSIVE on the table it references,
-- "api_key", until this migration commits. While it waits for that lock (an
-- open transaction that wrote "api_key"), every new write there queues
-- behind it:
--   a key's last use stamp, a revocation.
-- So each attempt waits at most 1 s (lock_timeout) and gives way for 1 s
-- before the next one, up to 30 attempts. A lock that never comes fails
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
      AND conname = 'delivery_event_part_apiKeyId_fkey'
  ) THEN
    RETURN;
  END IF;

  PERFORM set_config('lock_timeout', '1s', true);

  LOOP
    BEGIN
      ALTER TABLE "delivery_event_part"
        ADD CONSTRAINT "delivery_event_part_apiKeyId_fkey"
        FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;
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
