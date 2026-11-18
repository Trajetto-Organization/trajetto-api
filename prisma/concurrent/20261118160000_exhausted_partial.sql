-- The rows in flight of each queue, by when their lease ends (plano-escala
-- F3-08): what the minute's close of the exhausted rows reads
-- (src/shared/queue/exhausted-close.ts). Partial on PROCESSING, so each
-- holds only the rows a process is working on, whatever is queued behind
-- them: the close used to run before every claim and walk the claim's
-- index, every due row included. Built here before the migrations; the
-- migration of the same name keeps the history (and builds them on an
-- empty table).
-- requires-table: domain_outbox_event
-- requires-table: notification_delivery
-- requires-table: webhook_delivery

CREATE INDEX CONCURRENTLY IF NOT EXISTS "domain_outbox_event_processing_lease_idx" ON "domain_outbox_event" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_delivery_processing_lease_idx" ON "notification_delivery" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_delivery_processing_lease_idx" ON "webhook_delivery" ("leaseExpiresAt") WHERE "status" = 'PROCESSING';
