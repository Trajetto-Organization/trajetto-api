-- A checklist made for a route, and for which moment of it (plan of
-- 02/11/2026, items C4 and F3; decisions D08 and D09: one checklist per
-- route, at departure and/or at arrival, as the company decides).
--
--   "routeId"  the route the driver was about to start or had just finished.
--              SET NULL: the checklist is a record of the vehicle and must
--              outlive the route (reversing an import deletes its routes).
--   "phase"    STANDALONE for every checklist made outside a route — all the
--              existing ones, and every one the serving image still writes
--              (its INSERTs leave the column out and get the default).
--
-- The route's "checklist done?" is derived from these rows (no flag on the
-- route), so a checklist with photos that arrives after the start still
-- counts.
--
-- Expand-safe: a nullable column and an enum column with a constant default
-- (catalog-only on PostgreSQL 11+), both unknown to the serving image; the
-- enum type is new (20261102120000), so no running client parses its values.

SET lock_timeout = '5s';

ALTER TABLE "vehicle_checklist"
  ADD COLUMN IF NOT EXISTS "routeId" TEXT,
  ADD COLUMN IF NOT EXISTS "phase" "ChecklistPhase" NOT NULL DEFAULT 'STANDALONE';

-- A route's checklists (the route detail, the app's payload) and the SET NULL
-- when a route is deleted.
CREATE INDEX IF NOT EXISTS "vehicle_checklist_routeId_idx" ON "vehicle_checklist"("routeId");

ALTER TABLE "vehicle_checklist" ADD CONSTRAINT "vehicle_checklist_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;
