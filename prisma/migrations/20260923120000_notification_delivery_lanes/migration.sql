-- One claim index per delivery lane.
--
-- The pipeline claims deliveries in two lanes — internal (IN_APP, ACTIVITY,
-- PUSH) and external (EMAIL, WHATSAPP) — so a slow or hung provider can no
-- longer hold the slots the in-app bell, the phone push and the chat need.
-- Each lane scans its own partial index in created_at order: the internal
-- lane never walks past a backlog of e-mails to find the next notification,
-- which is exactly what one shared index would make it do during an outage.
--
-- The channel lists here and in DELIVERY_LANES (pipeline-rules.ts) must stay
-- the same; the claim spells them as literals so the planner can prove the
-- predicate of these indexes.
--
-- Plain CREATE INDEX, as in 20260908120000_harden_queue_tables: migrations run
-- in a transaction, and the table is a small work queue (terminal rows are
-- purged), so the SHARE lock lasts milliseconds.
CREATE INDEX IF NOT EXISTS "notification_delivery_claim_internal_idx"
  ON "notification_delivery" ("created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING')
    AND "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH');

CREATE INDEX IF NOT EXISTS "notification_delivery_claim_external_idx"
  ON "notification_delivery" ("created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING')
    AND "channel" IN ('EMAIL', 'WHATSAPP');

-- The single-lane claim index has no reader left, and every write to the
-- queue would keep paying for it.
DROP INDEX IF EXISTS "notification_delivery_claim_idx";
