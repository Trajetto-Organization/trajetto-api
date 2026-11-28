-- The routes list in its default order (plan of 02/11/2026, item K14).
--
-- The panel lists a company's routes newest first (route-list.ts sorts by
-- created_at), and no index served it: the plan read every route of the
-- company and sorted them for each page. With this one it reads the page.
-- Same shape as delivery_event_businessId_created_at_idx.
--
-- Expand-safe: a new index, unknown to the serving image. Plain CREATE INDEX
-- for the reason given in 20261007120000_db_perf_indexes (Prisma runs this
-- file in a transaction); on a database with volume, build it first with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS and this name and definition, and
-- this statement does nothing.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "route_businessId_created_at_idx" ON "route"("businessId", "created_at" DESC);
