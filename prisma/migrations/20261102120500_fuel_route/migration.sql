-- A refuelling made during a route (plan of 02/11/2026, items C5 and F3):
-- the route detail on the web lists what happened to the vehicle on it.
--
-- SET NULL, like the checklist's: the refuelling is a record of the vehicle
-- and outlives the route. Null on every existing refuelling and on every one
-- made outside a route.
--
-- Expand-safe: a nullable column with no default (catalog-only) that the
-- serving image never reads or writes.

SET lock_timeout = '5s';

ALTER TABLE "fuel" ADD COLUMN IF NOT EXISTS "routeId" TEXT;

-- A route's refuellings and the SET NULL when a route is deleted.
CREATE INDEX IF NOT EXISTS "fuel_routeId_idx" ON "fuel"("routeId");

ALTER TABLE "fuel" ADD CONSTRAINT "fuel_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;
