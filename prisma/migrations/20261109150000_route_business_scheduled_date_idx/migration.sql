-- The period of the routes (plan of 09/11/2026): the Rotas list and the
-- Torre's board by route read Hoje / 7 / 14 / 30 dias / Personalizado by the
-- route's day.
--
-- A range of scheduled_date with no status fixed had no index to lead with:
-- route_businessId_status_scheduled_date_idx starts with the status, and
-- Postgres 16 has no skip scan, so each page and each count read every
-- route of the company to keep the period's. With this one a read is
-- proportional to the period (at most 92 days), not to the history.
--
-- Expand-safe: a new index, unknown to the serving image. Plain CREATE INDEX
-- for the reason given in 20261007120000_db_perf_indexes (Prisma runs this
-- file in a transaction); on a database with volume, build it first with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS and this name and definition, and
-- this statement does nothing.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "route_businessId_scheduled_date_idx" ON "route"("businessId", "scheduled_date");
