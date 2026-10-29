-- Indexes from the db-perf pass of 07/10/2026, each justified by an EXPLAIN
-- ANALYZE on a scratch database with 50 companies, 1M deliveries, 3M events,
-- 2M notification deliveries and 1M activities (docs/desempenho/banco-2026-10.md
-- has the before/after of each; tests/E2E/query-plans-scale.test.ts pins the
-- access path of each one through the repository that runs it).
--
-- Added:
--  1. route_stop (status, deliveryId): "not on an open stop" is an
--     uncorrelated NOT IN whose hash came from a scan of every stop ever made
--     (the partial unique index cannot match Prisma's CAST($n AS enum)). The
--     app's pending count and each of the six route-builder queries: 150 ms
--     -> 3-6 ms.
--  2. delivery (businessId, status, shipperId, driverId): the listing's three
--     filter counts as index-only scans; deduplicated to 12 MB per 1M rows.
--     480 ms -> 85 ms per page for a company with 300k deliveries.
--  3. delivery (businessId, id): the public API's keyset pages of a small
--     company walked the whole primary key.
--  4. delivery_occurrence (businessId, occurrenceTypeId): the per-type counts
--     were a scan of every company's occurrences.
--  5. notification (userId, read, created_at DESC): the unread badge visited
--     every kept notification of the user (136 ms -> under 1 ms).
--  6. activity (businessId, performedBy, visibilityLevel): the trail's total
--     visited every row (288 ms -> 107 ms on 300k rows).
--  7. delivery_proof_audit (businessId, status, reviewed_at DESC, id DESC):
--     the history tabs top-N sorted the company's decided cards.
--  8. webhook_delivery (businessId, status, created_at, latency_ms) replaces
--     (businessId, status, created_at): same prefix, and the p95 becomes an
--     index-only scan (245 ms -> 12 ms).
--  9. support_ticket inbox orders (raw SQL: NULLS LAST cannot be declared in
--     schema.prisma, see the SupportTicket model): "Encerrados" and "Todos"
--     top-N sorted the company's tickets.
-- 10. api_key_usage_daily (day): the new nightly purge (400 days) walks the
--     oldest days instead of scanning the table.
--
-- Dropped (each is a strict prefix of another index on the same table, so the
-- planner has an equivalent path and every write paid for two):
--  - delivery_event_deliveryId_idx      covered by (deliveryId, created_at)
--  - shipper_businessId_idx             covered by the (businessId, name) unique
--  - occurrence_type_businessId_idx     covered by the (businessId, name) unique
--  - status_change_reason_businessId_idx covered by the (businessId, name) unique
--  - webhook_delivery_businessId_status_created_at_idx  replaced by (8)
--
-- Plain CREATE INDEX, as in 20260924090500_delivery_read_indexes: Prisma runs
-- this file in a transaction, where CONCURRENTLY is refused. On a database
-- that already holds volume, build each index by hand first with CREATE INDEX
-- CONCURRENTLY IF NOT EXISTS and the same name and definition; this file then
-- only drops what it replaces.

CREATE INDEX IF NOT EXISTS "route_stop_status_deliveryId_idx"
  ON "route_stop"("status", "deliveryId");

CREATE INDEX IF NOT EXISTS "delivery_businessId_status_shipperId_driverId_idx"
  ON "delivery"("businessId", "status", "shipperId", "driverId");

CREATE INDEX IF NOT EXISTS "delivery_businessId_id_idx"
  ON "delivery"("businessId", "id");

CREATE INDEX IF NOT EXISTS "delivery_occurrence_businessId_occurrenceTypeId_idx"
  ON "delivery_occurrence"("businessId", "occurrenceTypeId");

CREATE INDEX IF NOT EXISTS "notification_userId_read_created_at_idx"
  ON "notification"("userId", "read", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "activity_businessId_performedBy_visibilityLevel_idx"
  ON "activity"("businessId", "performedBy", "visibilityLevel");

CREATE INDEX IF NOT EXISTS "delivery_proof_audit_businessId_status_reviewed_at_id_idx"
  ON "delivery_proof_audit"("businessId", "status", "reviewed_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "webhook_delivery_businessId_status_created_at_latency_ms_idx"
  ON "webhook_delivery"("businessId", "status", "created_at", "latency_ms");

CREATE INDEX IF NOT EXISTS "support_ticket_closed_inbox_idx"
  ON "support_ticket" ("businessId", "status", "closed_at" DESC NULLS LAST, "id" DESC);

CREATE INDEX IF NOT EXISTS "support_ticket_all_inbox_idx"
  ON "support_ticket" ("businessId", "last_message_at" DESC NULLS LAST, "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "api_key_usage_daily_day_idx"
  ON "api_key_usage_daily"("day");

DROP INDEX IF EXISTS "delivery_event_deliveryId_idx";
DROP INDEX IF EXISTS "shipper_businessId_idx";
DROP INDEX IF EXISTS "occurrence_type_businessId_idx";
DROP INDEX IF EXISTS "status_change_reason_businessId_idx";
DROP INDEX IF EXISTS "webhook_delivery_businessId_status_created_at_idx";
