-- Statistics and autovacuum per tenant on the hot tables (plano-escala F2-22).
--
-- The planner reads one row count for "businessId = X" off a list of the
-- 100 commonest companies; with 3,600 carriers the rest share one guess, and
-- a big carrier's queries were planned like a small one's. A target of 1000
-- keeps the 1000 commonest. The dependencies tell it that a driver belongs
-- to one company: it multiplied the company's share of the rows by the
-- driver's, the same fact counted twice, and planned the app's count of one
-- driver's deliveries 20 to 200 times too small (tests/E2E/query-plans-scale).
-- No MCV list on these pairs (the plan said "mcv, dependencies"): Postgres
-- applies an MCV list before any dependency, so one on (businessId, status)
-- took the company clause and left the driver's to be multiplied again.
-- Measured on a small company's driver: 1 row estimated for 200 real ones
-- with the MCV list, 160 with the dependencies alone.
--
-- Autovacuum at 2% of dead rows and ANALYZE at 1% of changes, instead of
-- 20% and 10%: on a table of 5M deliveries the default waited for a million
-- dead rows, and the statistics of today's statuses lagged a whole day.
--
-- Each statement takes SHARE UPDATE EXCLUSIVE (writes go on; a vacuum or an
-- ANALYZE of the table waits) and is skipped once the catalog has it. The
-- migration of the same name does the same on a new database.
-- requires-table: delivery
-- requires-table: delivery_event
-- requires-table: route
-- requires-table: route_stop
-- requires-table: delivery_occurrence
-- requires-table: activity
-- requires-table: webhook_delivery

ALTER TABLE "delivery" ALTER COLUMN "businessId" SET STATISTICS 1000;
ALTER TABLE "delivery_event" ALTER COLUMN "businessId" SET STATISTICS 1000;
ALTER TABLE "route" ALTER COLUMN "businessId" SET STATISTICS 1000;
ALTER TABLE "delivery_occurrence" ALTER COLUMN "businessId" SET STATISTICS 1000;
ALTER TABLE "activity" ALTER COLUMN "businessId" SET STATISTICS 1000;
ALTER TABLE "webhook_delivery" ALTER COLUMN "businessId" SET STATISTICS 1000;

CREATE STATISTICS IF NOT EXISTS "delivery_business_status_stats" (dependencies) ON "businessId", "status" FROM "delivery";
CREATE STATISTICS IF NOT EXISTS "delivery_business_driver_stats" (dependencies) ON "businessId", "driverId" FROM "delivery";
CREATE STATISTICS IF NOT EXISTS "route_business_status_stats" (dependencies) ON "businessId", "status" FROM "route";
CREATE STATISTICS IF NOT EXISTS "route_business_driver_stats" (dependencies) ON "businessId", "driverId" FROM "route";

ALTER TABLE "delivery" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "route" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "route_stop" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "delivery_occurrence" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
