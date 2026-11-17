-- The fair claim's indexes, one per delivery lane (plano-escala F3-09):
-- the claimable rows of the lane by company, then due time, so the claim of
-- wave 12 (F3-10) can take each company's oldest due row in turn instead of
-- the whole lane's. Same predicate as the lane's claim index, with the
-- lane's literal channels (DELIVERY_LANES in pipeline-rules.ts). The column
-- arrives in the same release
-- (migrations/20261117210000_notification_delivery_business): this file
-- waits for it and runs in the second pass, after the migrations.
-- requires-table: notification_delivery
-- requires-column: notification_delivery.business_id

CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_delivery_business_internal_idx" ON "notification_delivery" ("business_id", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH');

CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_delivery_business_external_idx" ON "notification_delivery" ("business_id", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING') AND "channel" IN ('EMAIL', 'WHATSAPP');
