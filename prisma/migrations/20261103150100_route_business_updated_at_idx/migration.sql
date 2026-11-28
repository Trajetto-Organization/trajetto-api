-- The public API's incremental sync of routes (plan of 02/11/2026, L6).
--
-- GET /integration/v1/routes?updated_since=... filters on updated_at but
-- pages by id, and no index led with (businessId, updated_at): measured
-- before this index (tests/E2E/integration-updated-since-plan), the poll of
-- the last half hour of the biggest company read all 30,000 routes of the
-- table for 40 changed (sequential scan), and a small company's read all
-- 2,000 of its routes for 2. With it, the window is read and the page
-- sorted.
--
-- One hot table per file: the delivery index is 20261103150000.
--
-- Expand-safe: a new index, unknown to the serving image. Plain CREATE INDEX
-- for the reason given in 20261007120000_db_perf_indexes; on a database with
-- volume, build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and this
-- name and definition, and this statement does nothing.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "route_businessId_updated_at_idx" ON "route"("businessId", "updated_at");
