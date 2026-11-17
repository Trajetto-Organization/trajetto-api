-- ----------------------------------------------------------------------------
-- notification_delivery.business_id (plano-escala F3-09)
-- ----------------------------------------------------------------------------
-- The two delivery lanes are claimed oldest-due first across every company
-- (notification_delivery_claim_internal_idx and _external_idx): a carrier
-- that fires 20,000 notices at once puts every other company's bell, push
-- and e-mail behind them. The fair claim of wave 12 (F3-10) takes the lane
-- company by company, a recursive skip scan over (business_id, availableAt);
-- this file is the groundwork: the company on the row, copied from the
-- event when it expands (notification-pipeline-service.ts), and one partial
-- index per lane with the lane's literal channels (DELIVERY_LANES in
-- pipeline-rules.ts) and the claimable statuses, the same predicate as the
-- lane's own claim index.
--
-- No backfill: the rows written before this, and the platform's own events
-- (no company), stay NULL, and NULL is the fair claim's "no company" bucket.
-- They drain within the retention anyway.
--
-- Expand only. ADD COLUMN with no default is catalog-only; the serving
-- image never names the column, and a rollback leaves it NULL on the rows it
-- writes, which is the same bucket.
--
-- notification_delivery is hot: the two indexes are built with CREATE INDEX
-- CONCURRENTLY by prisma/concurrent/20261117210000_notification_delivery_business.sql
-- in the second pass of the release step, right after the migrations (the
-- column only exists from here on). This file builds them only on an empty
-- table (a new database: the E2E template, `yarn dev`, Prisma's shadow
-- database). By hand on a database with volume (PREBUILD_ONLINE_DDL=off):
-- (1) the ALTER TABLE ... ADD COLUMN IF NOT EXISTS below; (2) the two
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS of that file, outside a
-- transaction; (3) check that pg_index.indisvalid is true for both.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "business_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "notification_delivery" LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "notification_delivery_business_internal_idx" ON "notification_delivery" ("business_id", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH');
    CREATE INDEX IF NOT EXISTS "notification_delivery_business_external_idx" ON "notification_delivery" ("business_id", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "channel" IN ('EMAIL', 'WHATSAPP');
  END IF;
END $$;
