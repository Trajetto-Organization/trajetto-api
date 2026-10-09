-- The webhook ledger gets a purge and a monitor that do not read its whole
-- history.
--
-- webhook_delivery was never purged, although the replay window is 30 days
-- (REPLAY_WINDOW_DAYS) and each row carries the payload twice plus up to a
-- kilobyte of the receiver's answer. And the monitor counted and grouped by
-- status over the tenant's entire history on every refresh.
--
--   webhook_delivery_businessId_status_created_at_idx: the monitor's counters
--     and p95 — this tenant, this status, since then — without touching the
--     rows of the other statuses. Declared in schema.prisma.
--
--   webhook_delivery_purge_idx: PARTIAL on the terminal statuses, by
--     created_at, so the nightly purge walks from the oldest DELIVERED/FAILED
--     row and stops at the cutoff. The statuses are part of the predicate on
--     purpose: a row still PENDING or PROCESSING belongs to the dispatcher,
--     whatever its age, and the purge must not even see it. A row enters this
--     index once, when it settles.
--
--   webhook_delivery_failed_idx: PARTIAL on FAILED, by updated_at — "failures
--     in the last 24 hours" across tenants on /health/metrics. FAILED rows are
--     few, so it stays small.
--
-- The two partial ones are raw SQL: Prisma cannot declare a partial index, and
-- its diff ignores them (the WebhookDelivery model names both).
--
-- Plain CREATE INDEX, as in 20260916170000_integrations: the table is created
-- by this same release and is empty in production when this runs. On a large
-- database, build them by hand first with CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS and the same names; this file then does nothing.

CREATE INDEX IF NOT EXISTS "webhook_delivery_businessId_status_created_at_idx"
  ON "webhook_delivery"("businessId", "status", "created_at");

CREATE INDEX IF NOT EXISTS "webhook_delivery_purge_idx"
  ON "webhook_delivery" ("created_at")
  WHERE "status" IN ('DELIVERED', 'FAILED');

CREATE INDEX IF NOT EXISTS "webhook_delivery_failed_idx"
  ON "webhook_delivery" ("updated_at")
  WHERE "status" = 'FAILED';
