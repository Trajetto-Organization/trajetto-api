-- ----------------------------------------------------------------------------
-- driver_position_v2: the lean GPS trail (plano-escala F2-10)
-- ----------------------------------------------------------------------------
-- The trail is the one table that grows with TIME (about 2,400 points per
-- driver in a ten-hour day), and each of its rows carried three indexes and
-- a uuid nobody reads: about 565 bytes a row, measured on interleaved
-- flushes of 300 drivers. This table keeps what the trail is read by and
-- nothing else, at about 204 bytes a row on the same flushes:
--
-- - no "id": the point IS (driverId, recorded_at), the dedupe key the
--   insert already skipped duplicates on, so it is the primary key;
-- - no index on ("businessId", recorded_at): the only reader is the trail
--   of one driver (DriverPositionRepository.listTrail), which goes down the
--   primary key; the company stays in its WHERE as the second lock;
-- - no created_at: nothing reads when a point arrived;
-- - the ids as uuid (16 bytes) instead of text (37): every id the trail
--   holds is a Driver, Business or Route id, all uuids.
--
-- Partitioned by day on recorded_at like the legacy table, so the purge is
-- a DROP of a whole day; the nightly partition-maintenance job keeps both
-- tables (src/shared/database/partitions.ts), and the release step makes
-- trajetto_partitions their owner (infra/sql/10-partitions.sql). No foreign
-- key, as before: the hottest write path of the product checks nothing.
--
-- Expand only. The image that brings this writes here and reads the trail
-- from BOTH tables (DISTINCT ON the instant) while the legacy one exists:
-- during the rolling deploy the previous image still writes driver_position,
-- and a batch resent across the two images lands once in each; the reader
-- counts it once. A rollback writes the legacy table again and leaves this
-- one unread (its points are lost to the old image; an INSERT ... SELECT
-- into driver_position brings them back). The legacy table goes in a later
-- release (F2-12), once DRIVER_POSITION_RETENTION_DAYS has passed.
--
-- The partitions from yesterday to a week ahead, as the legacy migration
-- made them: the new image writes here right after the deploy, before the
-- nightly job has run. A new, empty table: nothing waits on its locks.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "driver_position_v2" (
    "driverId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "routeId" UUID,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "battery" SMALLINT,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_position_v2_pkey" PRIMARY KEY ("driverId", "recorded_at")
) PARTITION BY RANGE ("recorded_at");

DO $$
DECLARE
  day DATE := (CURRENT_DATE - INTERVAL '1 day')::DATE;
  last_day DATE := (CURRENT_DATE + INTERVAL '7 days')::DATE;
BEGIN
  WHILE day <= last_day LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "driver_position_v2"
         FOR VALUES FROM (%L) TO (%L)',
      'driver_position_v2_' || to_char(day, 'YYYYMMDD'),
      day,
      day + 1
    );

    day := day + 1;
  END LOOP;
END $$;
