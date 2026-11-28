-- ----------------------------------------------------------------------------
-- Statistics and autovacuum per tenant on the hot tables (plano-escala F2-22)
-- ----------------------------------------------------------------------------
-- The why is in prisma/concurrent/20261117180000_tenant_statistics.sql,
-- which the release step runs BEFORE this migration on a database with
-- rows: there each statement waits for its lock with lock_timeout and
-- retries, outside any transaction.
--
-- Here the same statements run only where the catalog does not have them
-- yet: on a new database (the E2E template, `yarn dev`), or with the online
-- step turned off (PREBUILD_ONLINE_DDL=off). Each one takes SHARE UPDATE
-- EXCLUSIVE, the lock of every vacuum, held until this migration commits;
-- repeated where it is already in place, it would queue behind an
-- anti-wraparound vacuum (which does not yield) and fail the release.
--
-- Expand-safe: planner settings only. No column, no row and no answer
-- changes, so the serving image and a rollback read the same; RESET (or a
-- target of -1, or DROP STATISTICS) undoes any of them.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

DO $$
BEGIN
  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"delivery"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "delivery" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"delivery_event"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "delivery_event" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"route"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "route" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"delivery_occurrence"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "delivery_occurrence" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"activity"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "activity" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF (SELECT attstattarget FROM pg_attribute WHERE attrelid = '"webhook_delivery"'::regclass AND attname = 'businessId') IS DISTINCT FROM 1000 THEN
    ALTER TABLE "webhook_delivery" ALTER COLUMN "businessId" SET STATISTICS 1000;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_statistic_ext WHERE stxname = 'delivery_business_status_stats' AND stxnamespace = current_schema()::regnamespace) THEN
    CREATE STATISTICS IF NOT EXISTS "delivery_business_status_stats" (dependencies) ON "businessId", "status" FROM "delivery";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_statistic_ext WHERE stxname = 'delivery_business_driver_stats' AND stxnamespace = current_schema()::regnamespace) THEN
    CREATE STATISTICS IF NOT EXISTS "delivery_business_driver_stats" (dependencies) ON "businessId", "driverId" FROM "delivery";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_statistic_ext WHERE stxname = 'route_business_status_stats' AND stxnamespace = current_schema()::regnamespace) THEN
    CREATE STATISTICS IF NOT EXISTS "route_business_status_stats" (dependencies) ON "businessId", "status" FROM "route";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_statistic_ext WHERE stxname = 'route_business_driver_stats' AND stxnamespace = current_schema()::regnamespace) THEN
    CREATE STATISTICS IF NOT EXISTS "route_business_driver_stats" (dependencies) ON "businessId", "driverId" FROM "route";
  END IF;

  IF NOT (SELECT coalesce(reloptions, '{}') @> ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.01'] FROM pg_class WHERE oid = '"delivery"'::regclass) THEN
    ALTER TABLE "delivery" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
  END IF;

  IF NOT (SELECT coalesce(reloptions, '{}') @> ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.01'] FROM pg_class WHERE oid = '"route"'::regclass) THEN
    ALTER TABLE "route" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
  END IF;

  IF NOT (SELECT coalesce(reloptions, '{}') @> ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.01'] FROM pg_class WHERE oid = '"route_stop"'::regclass) THEN
    ALTER TABLE "route_stop" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
  END IF;

  IF NOT (SELECT coalesce(reloptions, '{}') @> ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.01'] FROM pg_class WHERE oid = '"delivery_occurrence"'::regclass) THEN
    ALTER TABLE "delivery_occurrence" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
  END IF;
END $$;
