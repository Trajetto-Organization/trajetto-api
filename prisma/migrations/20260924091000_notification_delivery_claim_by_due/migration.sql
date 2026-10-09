-- The lane claim indexes, keyed on availableAt instead of created_at.
--
-- A delivery in backoff keeps its original created_at, so during a provider
-- outage the retrying rows sit at the HEAD of a created_at index: every claim
-- of the external lane — which also serves e-mail — visited the whole backlog
-- in the heap (availableAt in the future, filtered out one by one) before
-- reaching a row that was due. Keyed on availableAt, with the claim writing
-- availableAt = the lease end when it takes a row, the claim becomes
-- "availableAt <= now() ORDER BY availableAt": the scan starts at the oldest
-- due row and stops at now(), whatever is parked in backoff.
--
-- Same names and the same predicates (the channel lists must stay equal to
-- DELIVERY_LANES in pipeline-rules.ts), so the claim and the tests that name
-- the indexes are unaffected. Each new index is built under a temporary name
-- and swapped in, so the ACCESS EXCLUSIVE lock DROP INDEX takes is held for
-- the swap and not for the build.
--
-- Plain CREATE INDEX, as in 20260923120000_notification_delivery_lanes: the
-- table is created by this same release and is empty in production when this
-- runs. On a large database, run by hand first:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_delivery_claim_internal_due_idx" ... ;
--   DROP INDEX CONCURRENTLY IF EXISTS "notification_delivery_claim_internal_idx";
-- (and the same for external) — this file then only renames.

CREATE INDEX IF NOT EXISTS "notification_delivery_claim_internal_due_idx"
  ON "notification_delivery" ("availableAt")
  WHERE "status" IN ('PENDING', 'PROCESSING')
    AND "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH');

DROP INDEX IF EXISTS "notification_delivery_claim_internal_idx";

ALTER INDEX "notification_delivery_claim_internal_due_idx"
  RENAME TO "notification_delivery_claim_internal_idx";

CREATE INDEX IF NOT EXISTS "notification_delivery_claim_external_due_idx"
  ON "notification_delivery" ("availableAt")
  WHERE "status" IN ('PENDING', 'PROCESSING')
    AND "channel" IN ('EMAIL', 'WHATSAPP');

DROP INDEX IF EXISTS "notification_delivery_claim_external_idx";

ALTER INDEX "notification_delivery_claim_external_due_idx"
  RENAME TO "notification_delivery_claim_external_idx";
