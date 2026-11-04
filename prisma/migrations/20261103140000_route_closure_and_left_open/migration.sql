-- A route forgotten "Em andamento" (plan of 02/11/2026, item K11; decision
-- D26). A route closes itself when its last stop is resolved, and nothing
-- else closed it: a driver who never resolved the last stop left the route
-- running for days, holding the driver (ROUTE_DRIVER_BUSY) and the truck.
--
--   "closure_reason"        why a dispatcher closed the route with stops still
--                           open ("Encerrar com pendências"): the open stops
--                           were cancelled and their deliveries went back to
--                           Pendente. Null on every route that closed by
--                           itself, and on every existing one.
--   "left_open_alerted_at"  when the hourly sweep warned the company's
--                           admins that the route was left open: the claim
--                           that makes the warning once per route, whatever
--                           replica runs the sweep and however often.
--
-- Expand-safe: two nullable columns with no default (catalog-only) that the
-- serving image never reads or writes. The sweep reads the running routes
-- through route_active_vehicle_idx (status = 'IN_PROGRESS'), so no index.

SET lock_timeout = '5s';

ALTER TABLE "route"
  ADD COLUMN IF NOT EXISTS "closure_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "left_open_alerted_at" TIMESTAMP(3);
