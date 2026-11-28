-- driver_last_position with HOT updates (plano-escala F2-13).
--
-- One row per driver, rewritten on every flush (about 167 flushes a second
-- at the peak of 20.000 drivers). Each rewrite changes recorded_at, and the
-- old index ("businessId", "recorded_at" DESC) holds recorded_at: so no
-- update could be HOT (heap-only), every one of them wrote a new entry in
-- both indexes and left a dead one behind for the vacuum. With the index on
-- ("businessId") alone, a rewrite changes no indexed column, and with room
-- left on the page (fillfactor 80) the new version goes on the same page
-- with no index write at all. The tower still finds a company's drivers by
-- that index and sorts its few rows (one per driver) by recorded_at.
--
-- prisma/concurrent/20261117170000_driver_last_position_hot.sql builds the
-- new index with CREATE INDEX CONCURRENTLY and drops the old one with DROP
-- INDEX CONCURRENTLY before this migration runs: on a database with rows
-- both statements below find it done and do nothing; on a new database
-- (the E2E template, `yarn dev`) they run on an empty table.
--
-- Expand-safe: the serving image's reads work the same with either index
-- (the plan changes, the answer does not), and a rollback keeps this one.
-- The fillfactor only applies to the pages written from now on; it takes
-- SHARE UPDATE EXCLUSIVE, which no insert or update waits for.

SET lock_timeout = '5s';

ALTER TABLE "driver_last_position" SET (fillfactor = 80);

CREATE INDEX IF NOT EXISTS "driver_last_position_businessId_idx" ON "driver_last_position"("businessId");

DROP INDEX IF EXISTS "driver_last_position_businessId_recorded_at_idx";
