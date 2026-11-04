-- "Parar de receber" by phone and e-mail inside the carrier (plan of
-- 02/11/2026, item B5; decision D38). The opt-out link stopped only the
-- delivery it came from (external_recipient.opted_out_at): somebody who
-- receives many deliveries from the same carrier kept getting the next one's
-- WhatsApp and e-mail. The public opt-out now also writes, in the same
-- transaction, one row per address the recipient row holds:
--
--   "channel"             WHATSAPP or EMAIL — only what reaches somebody
--                         outside the company; internal notices never read
--                         this table.
--   "address"             WHATSAPP: the phone as one line, E.164 digits
--                         without the "+" (normalizeSuppressionPhone): every
--                         non-digit and every leading dialling zero ("0",
--                         "00") dropped, "55" prepended to a 10- or 11-digit
--                         national number, and a 9 inserted after "55" + area
--                         code in a 12-digit number whose subscriber starts
--                         with 6-9 (an old 8-digit mobile; landlines start
--                         with 2-5) — "011 9123-4567" and "(11) 99123-4567"
--                         are both 5511991234567. The sender writes the same
--                         digits to Meta minus that ninth digit. EMAIL:
--                         trimmed and lower-cased.
--   "source_delivery_id"  the delivery whose link was clicked. No foreign
--                         key on purpose: the row outlives that delivery and
--                         the hot delivery table is not locked by this file.
--
-- Every customer message checks it when the event is expanded and again
-- when the message is sent, so one already queued is dropped. Kept while the
-- carrier exists (ON DELETE CASCADE); the carrier's team undoes it from the
-- delivery (POST /delivery/reactivate-customer-messages), which deletes the
-- rows of that recipient's phone and e-mail.
-- The unique key is the upsert's: a second click, or two replicas racing,
-- inserts nothing (ON CONFLICT DO NOTHING). It also serves the cascade and
-- the lookup by (business, channel, address).
--
-- Expand-safe: a new enum type and a new table that the serving image never
-- reads or writes. The foreign key to "business" takes a brief lock on that
-- hot table, hence the lock_timeout: a deploy that waits fails and retries
-- instead of queueing every request behind it.

SET lock_timeout = '5s';

CREATE TYPE "CustomerMessageChannel" AS ENUM ('WHATSAPP', 'EMAIL');

CREATE TABLE "customer_message_suppression" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "channel" "CustomerMessageChannel" NOT NULL,
    "address" TEXT NOT NULL,
    "source_delivery_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_message_suppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_message_suppression_businessId_channel_address_key" ON "customer_message_suppression"("businessId", "channel", "address");

ALTER TABLE "customer_message_suppression" ADD CONSTRAINT "customer_message_suppression_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
