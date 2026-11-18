-- ----------------------------------------------------------------------------
-- route_stop ("status", "deliveryId") leaves, on a new database only
-- (plano-escala F2-21b)
-- ----------------------------------------------------------------------------
-- "Not on an open stop" used to hash every open stop of the platform, and
-- this index fed that hash (20261007120000_db_perf_indexes). Since F2-21 the
-- filter looks for the stop through the company's open routes
-- (src/shared/route/open-stop-anti-join.ts) and nothing reads the index
-- any more: it only costs every write of route_stop.
--
-- contract-phase: the image from before the plan still runs the global
-- anti-join and wants the index, during the rolling deploy and after a
-- rollback, and the plan ships in one release. So on a database that is
-- serving (it has a company) this file does nothing, and the drop is
-- prisma/post-deploy/03-route-stop-status-index.sql, which waits until every
-- live process announces route-stop-open-by-route-v1
-- (src/shared/health/capabilities.ts). Here the drop runs only on a database
-- with no company (the E2E template, Prisma's shadow database, `yarn dev`
-- from scratch), so the migrations' history ends where prisma/schema.prisma
-- does and `prisma migrate dev` never proposes the drop again.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "business" LIMIT 1) THEN
    DROP INDEX IF EXISTS "route_stop_status_deliveryId_idx";
  END IF;
END $$;
