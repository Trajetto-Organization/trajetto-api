-- Indexes for three reads of the delivery tables that cost O(history).
--
-- 1. The "today" counters of the operation summary (dashboard, monitoring
--    tab). deliveredToday / failedToday filter status + delivered_at (or
--    updated_at) >= start of today, and no index had either timestamp: every
--    call walked all of the tenant's DELIVERED (or FAILED) rows and checked
--    the date in the heap — a cost that grows with the customer's age, not
--    with today's work. Partial on the status, with driverId INCLUDEd so the
--    per-driver breakdown is an index-only scan. The status must reach the
--    planner as a LITERAL for a partial index to be provable in a generic
--    plan; the query that uses them spells it that way.
--
-- 2. The spreadsheet import's order lookup: for a row without an NF-e key the
--    identity is (shipper, order code), checked under an advisory lock on that
--    triple (ADR 0006). The only index that could serve it was (shipperId),
--    with the code filtered in the heap across the shipper's whole history —
--    and the lock is held for as long as that lookup takes. Not unique: two
--    manual deliveries with the same order code can be legitimate.
--
-- 3. /integration/v1/events walks one tenant's events by id (uuid v7, so time
--    ordered) with a cursor. It joined through delivery and walked the ids of
--    every tenant; with delivery_event.businessId (20260923150000) and this
--    index it is a range scan of that tenant only.
--
-- (1) is raw SQL because Prisma cannot declare a partial index — its diff
-- ignores them, and the Delivery model names both. (2) and (3) are declared in
-- schema.prisma.
--
-- Plain CREATE INDEX, as in 20260908120000_harden_queue_tables: the delivery
-- tables are created by this same release and are empty in production when
-- this runs. On a large database, build these by hand first with CREATE INDEX
-- CONCURRENTLY IF NOT EXISTS and the same names; this file then does nothing.

CREATE INDEX IF NOT EXISTS "delivery_delivered_today_idx"
  ON "delivery" ("businessId", "delivered_at") INCLUDE ("driverId")
  WHERE "status" = 'DELIVERED';

CREATE INDEX IF NOT EXISTS "delivery_failed_recent_idx"
  ON "delivery" ("businessId", "updated_at") INCLUDE ("driverId")
  WHERE "status" = 'FAILED';

CREATE INDEX IF NOT EXISTS "delivery_businessId_shipperId_code_idx"
  ON "delivery"("businessId", "shipperId", "code");

CREATE INDEX IF NOT EXISTS "delivery_event_businessId_id_idx"
  ON "delivery_event"("businessId", "id");
