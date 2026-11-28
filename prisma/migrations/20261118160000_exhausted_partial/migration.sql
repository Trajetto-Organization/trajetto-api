-- ----------------------------------------------------------------------------
-- The queues' rows in flight by lease end (plano-escala F3-08)
-- ----------------------------------------------------------------------------
-- A row whose last allowed attempt died with its process stays PROCESSING,
-- its lease run out and its attempts at the ceiling, until somebody closes
-- it FAILED. Each claim used to do that first, with an UPDATE that found
-- its rows through the claim's own index: every due row, PENDING ones
-- included, read to find the few in flight, so a flood of due e-mails made
-- every claim read the flood. The close is now a timer of each process,
-- once a minute (src/shared/queue/exhausted-close.ts), and reads these
-- partial indexes: only the rows in flight, whatever is queued behind them.
--
-- The three tables are hot: the indexes are built with CREATE INDEX
-- CONCURRENTLY by prisma/concurrent/20261118160000_exhausted_partial.sql in
-- the release step, before this file, and here they are a no-op (IF NOT
-- EXISTS). On a new database (the E2E template, `yarn dev`) this builds
-- them on empty tables. A partitioned queue gets them on the parent and on
-- every partition: the release step builds them ON ONLY and attaches each
-- partition's, and the partition swap copies the plain table's.
--
-- Expand only: nothing reads them before this release, and a rollback
-- leaves them in place, unused.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "domain_outbox_event_processing_lease_idx" ON "domain_outbox_event" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';

CREATE INDEX IF NOT EXISTS "notification_delivery_processing_lease_idx" ON "notification_delivery" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';

CREATE INDEX IF NOT EXISTS "webhook_delivery_processing_lease_idx" ON "webhook_delivery" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';
