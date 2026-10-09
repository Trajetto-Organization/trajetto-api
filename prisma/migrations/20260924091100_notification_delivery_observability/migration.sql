-- What /health/metrics and the dead letter read, and where the dead letter
-- goes before the purge.
--
-- 20260908120000_harden_queue_tables dropped notification_delivery's
-- (status, availableAt) index saying the table was never read by status
-- outside the claim. It was: /health/metrics groups FAILED deliveries by
-- channel and counts everything created in the last 24 hours, and
-- /health/dead-letter counts and pages FAILED rows by updated_at. No index
-- served any of them — each was a sequential scan of the widest table of the
-- pipeline, on a screen meant to be polled by alerting.
--
--   notification_delivery_failed_idx: PARTIAL on FAILED, (updated_at,
--     channel). Serves the dead-letter page newest-first (a backward scan that
--     stops at the page), its count, "failed in the last 24 hours" (a range on
--     the leading column), the failures per channel (index-only), and the
--     archiver below. FAILED rows are few, so it stays small. Raw SQL:
--     Prisma cannot declare a partial index, and its diff ignores them.
--
--   notification_delivery_created_at_brin_idx: BRIN on created_at, for the
--     last-24-hours counts over all statuses. Not a btree: every claim and
--     settle UPDATE moves `status`, a predicate column of the lane indexes, so
--     none is HOT and a btree would take an entry on each of them; rows
--     arrive in created_at order, so a BRIN of a few pages narrows the scan to
--     the recent block ranges. Declared in schema.prisma (type: Brin).
--
-- notification_dead_letter: the purge deletes PUBLISHED events 30 days after
-- processing and the cascade takes their deliveries — the FAILED ones and
-- their providerMessageId included, which is what support needs five weeks
-- later. The cleanup job copies them here first and keeps them 90 days. No
-- foreign keys: the row has to outlive everything it describes.
--
-- Plain CREATE INDEX, as in 20260923120000_notification_delivery_lanes: the
-- table is created by this same release and is empty in production when this
-- runs. On a large database, build both indexes by hand first with CREATE
-- INDEX CONCURRENTLY IF NOT EXISTS and the same names.

CREATE INDEX IF NOT EXISTS "notification_delivery_failed_idx"
  ON "notification_delivery" ("updated_at", "channel")
  WHERE "status" = 'FAILED';

CREATE INDEX IF NOT EXISTS "notification_delivery_created_at_brin_idx"
  ON "notification_delivery" USING BRIN ("created_at");

CREATE TABLE "notification_dead_letter" (
    "id" TEXT NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "businessId" TEXT,
    "userId" TEXT,
    "externalRecipientId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_dead_letter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_dead_letter_failedAt_idx"
  ON "notification_dead_letter"("failedAt");
