-- ============================================================================
-- Making a redelivery harmless where it can be, and auditable where it cannot
--
-- The pipeline claims a delivery, calls the provider, and then marks the row
-- DELIVERED. Nothing can make those two steps atomic — the provider is on the
-- other side of the network. If the process dies in between (a deploy, an OOM,
-- a lease expiring under a slow send) the lease lapses, another replica claims
-- the same row, and the message goes out a second time.
--
-- @@unique([outboxEventId, userId, channel]) already stops a second ROW. It
-- has never stopped a second SEND, and it was never meant to.
--
-- So each channel gets what it can actually have:
--
--   IN_APP    already solved: notification.deliveryId is unique, and the
--             pipeline treats the conflict as success.
--   ACTIVITY  solved here, same way. The audit trail is our own table, so a
--             duplicate is entirely preventable — and an audit trail that
--             double-counts is worse than useless, it is misleading.
--   EMAIL     mitigated, not solved. SMTP has no idempotency key; what it has
--             is Message-ID, and a deterministic one lets Gmail and most MTAs
--             suppress the copy. Not a guarantee.
--   PUSH      not solvable at this layer: Expo has no idempotency key.
--   WHATSAPP  not solvable at this layer: Meta's Cloud API has none either.
--
-- For the two that cannot be solved, providerMessageId at least makes an
-- incident answerable: which message, sent when, under which provider id.
-- ============================================================================

-- Nullable: every activity written directly by a use case has no delivery
-- behind it, and Postgres allows many NULLs under a unique constraint.
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "deliveryId" TEXT;

-- No foreign key on purpose. Deliveries are purged by
-- cleanup-notification-pipeline-job; the activity trail must survive that.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_deliveryId_key"
  ON "activity" ("deliveryId");

ALTER TABLE "notification_delivery"
  ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
