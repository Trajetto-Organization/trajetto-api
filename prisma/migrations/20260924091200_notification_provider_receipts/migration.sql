-- What the providers say after they accept a message.
--
-- DELIVERED meant "the provider accepted it" for e-mail, WhatsApp and push,
-- and nothing was recorded afterwards: a WhatsApp that Meta accepted and then
-- failed asynchronously (number without WhatsApp, paused template), an e-mail
-- that bounced, a push token Expo reports as gone only in its receipts — all
-- stayed DELIVERED. And WhatsApp has no idempotency key: a worker that dies
-- between Meta's 200 and the DELIVERED update sends again, and the single
-- providerMessageId column kept only the last wamid, so a duplicate could not
-- even be detected.
--
--   notification_delivery.providerStatus / providerStatusAt: the latest word
--     from the provider, forward-only. Nullable, no default: metadata-only.
--
--   notification_provider_receipt: every word, one row per report (Meta
--     status webhook, Resend webhook, Expo ticket and receipt). Unique on
--     (provider, providerMessageId, status) because providers retry their
--     callbacks. The foreign key cascades: the ledger lives as long as the
--     delivery it explains, and the purge's cascade from the event reaches it
--     through the deliveryId index.
--
--   notification_delivery_providerMessageId_idx: PARTIAL on the rows that have
--     one, for a callback that carries only the provider's id (a Resend event
--     without our tag, an old send without biz_opaque_callback_data). Only
--     provider-sent rows enter it, once, on the DELIVERED update. Raw SQL:
--     Prisma cannot declare a partial index, and its diff ignores them.
--
-- Plain CREATE INDEX: the pipeline tables are created by this same release and
-- are empty in production when this runs.

ALTER TABLE "notification_delivery"
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerStatusAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "notification_delivery_providerMessageId_idx"
  ON "notification_delivery" ("providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;

CREATE TABLE "notification_provider_receipt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "pushToken" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_provider_receipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_provider_receipt_provider_providerMessageId_st_key"
  ON "notification_provider_receipt"("provider", "providerMessageId", "status");

CREATE INDEX "notification_provider_receipt_deliveryId_idx"
  ON "notification_provider_receipt"("deliveryId");

CREATE INDEX "notification_provider_receipt_provider_status_created_at_idx"
  ON "notification_provider_receipt"("provider", "status", "created_at");

ALTER TABLE "notification_provider_receipt"
  ADD CONSTRAINT "notification_provider_receipt_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "notification_delivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
