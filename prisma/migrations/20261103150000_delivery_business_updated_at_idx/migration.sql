-- The public API's incremental sync of deliveries (plan of 02/11/2026, L6).
--
-- GET /integration/v1/deliveries?updated_since=... filters on updated_at but
-- pages by id, and only (businessId, id) served it: the walk read the
-- company's deliveries in id order until it had found a page of changed
-- ones. Measured before this index (tests/E2E/integration-updated-since-plan,
-- 300 thousand deliveries in three companies): the poll of the last half hour
-- of the biggest one (329 changed out of 200 thousand) read 300,000 rows —
-- every company's, by the primary key — and a small company's (31 changed)
-- read all of its 20,000. With it, the window is read and the page sorted
-- (329 and 31 rows).
--
-- Write cost on the busiest table: one more index entry per update. No HOT
-- update is lost, because updated_at was already indexed —
-- delivery_failed_recent_idx ("businessId", "updated_at") WHERE status =
-- 'FAILED' — and @updatedAt changes it on every update anyway.
--
-- Expand-safe: a new index, unknown to the serving image. Plain CREATE INDEX
-- for the reason given in 20261007120000_db_perf_indexes (Prisma runs this
-- file in a transaction, where CONCURRENTLY is refused); on a database with
-- volume, build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and this
-- name and definition, and this statement does nothing.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "delivery_businessId_updated_at_idx" ON "delivery"("businessId", "updated_at");
