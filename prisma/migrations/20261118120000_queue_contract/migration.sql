-- ----------------------------------------------------------------------------
-- The four queues lose their foreign keys and uniques, on a new database
-- only (plano-escala F5-06)
-- ----------------------------------------------------------------------------
-- domain_outbox_event, notification_delivery, notification_provider_receipt
-- and webhook_delivery become partitioned by day on their id (F5-09), and a
-- day is dropped whole (F5-11). A partitioned table cannot hold a unique
-- that leaves out its key, and a foreign key into a queue would hold every
-- drop. Wave 8 made the code stand without them: the outbox's keys live in
-- outbox_event_key (F5-02), the deliveries' and receipts' ids are decided
-- by the fact (F5-03, F5-04), and every deletion takes its own queue rows
-- (F5-05). What goes:
--
--   foreign keys  notification_delivery -> domain_outbox_event, "user",
--                 external_recipient; notification_provider_receipt ->
--                 notification_delivery; webhook_delivery ->
--                 webhook_endpoint, business;
--   uniques       domain_outbox_event ("eventKey"); notification_delivery
--                 (event, user, channel) and (event, external recipient,
--                 channel), both partial; notification_provider_receipt
--                 (provider, "providerMessageId", status), which stays as a
--                 plain index for the read that replaced it (insertReceipts).
--
-- contract-phase: the image from before the plan writes through the
-- uniques (ON CONFLICT, P2002) and deletes through the cascades, during the
-- rolling deploy and after a rollback, and the plan ships in one release.
-- So on a database that is serving (it has a company) this file only adds
-- the receipts' plain index (a no-op where prisma/concurrent built it) and
-- the contraction is prisma/post-deploy/05-queue-contract.sql, which waits
-- until every live process announces queue-partition-agnostic-v1
-- (src/shared/health/capabilities.ts) and backfills outbox_event_key once
-- more first. Here the contraction runs only on a database with no company
-- (the E2E template, Prisma's shadow database, `yarn dev` from scratch), so
-- the migrations' history ends where prisma/schema.prisma does and
-- `prisma migrate dev` never proposes it again.
--
-- The rollback floor, once the step has run, is this release
-- (docs/deploy.md, "Contrações que esperam a capability").
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

-- The receipts' read by fact, without the unique: built CONCURRENTLY by
-- prisma/concurrent/20261118120000_receipt_fact_index.sql before the
-- migrations where the table has rows.
CREATE INDEX IF NOT EXISTS "notification_provider_receipt_fact_idx" ON "notification_provider_receipt"("provider", "providerMessageId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "business" LIMIT 1) THEN
    ALTER TABLE "notification_delivery" DROP CONSTRAINT IF EXISTS "notification_delivery_outboxEventId_fkey";
    ALTER TABLE "notification_delivery" DROP CONSTRAINT IF EXISTS "notification_delivery_userId_fkey";
    ALTER TABLE "notification_delivery" DROP CONSTRAINT IF EXISTS "notification_delivery_externalRecipientId_fkey";
    ALTER TABLE "notification_provider_receipt" DROP CONSTRAINT IF EXISTS "notification_provider_receipt_deliveryId_fkey";
    ALTER TABLE "webhook_delivery" DROP CONSTRAINT IF EXISTS "webhook_delivery_endpointId_fkey";
    ALTER TABLE "webhook_delivery" DROP CONSTRAINT IF EXISTS "webhook_delivery_businessId_fkey";

    DROP INDEX IF EXISTS "domain_outbox_event_eventKey_key";
    DROP INDEX IF EXISTS "notification_delivery_user_event_channel_idx";
    DROP INDEX IF EXISTS "notification_delivery_external_event_channel_idx";
    DROP INDEX IF EXISTS "notification_provider_receipt_provider_providerMessageId_st_key";
  END IF;
END $$;
