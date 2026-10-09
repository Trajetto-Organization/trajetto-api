-- One point per driver per instant.
--
-- The phone clears its buffer before posting a batch and puts it back if the
-- post fails, so a response lost AFTER the commit (a timeout on a weak signal)
-- sends the same points again — and they were stored again: the primary key is
-- (id, recorded_at) with a random id, so nothing recognised a resend. The trail
-- doubled, and with it the distance and the evidence a dispute is settled with.
--
-- The plain index on (driverId, recorded_at DESC) becomes UNIQUE. It is the
-- same btree the map already reads, so the only added cost on this hot write
-- path is the uniqueness check; it contains the partition key, so it stays
-- local to each partition, and partitions created later by the cron
-- (CREATE TABLE ... PARTITION OF) inherit it. The insert must skip the
-- duplicates (ON CONFLICT DO NOTHING / createMany skipDuplicates), otherwise a
-- resent batch fails instead of being absorbed.
--
-- Existing duplicates would make the unique build fail, so they are removed
-- first: for each (driver, instant) the row with the smallest id — the first
-- one stored — is kept. The others are the same fix received twice; nothing is
-- lost. The table is created by this same release and is empty in production.

DELETE FROM "driver_position" AS later
USING "driver_position" AS first
WHERE later."driverId" = first."driverId"
  AND later."recorded_at" = first."recorded_at"
  AND later."id" > first."id";

CREATE UNIQUE INDEX IF NOT EXISTS "driver_position_driverId_recorded_at_key"
  ON "driver_position"("driverId", "recorded_at" DESC);

-- Superseded by the unique index above, which serves the same reads.
DROP INDEX IF EXISTS "driver_position_driverId_recorded_at_idx";
