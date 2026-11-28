-- Where the driver was, relative to the customer's address, when an arrival
-- or a proof was recorded (plan of 02/11/2026, items E2 and E4; decisions
-- D12-D14 and the owner's call on D13: the radius covers every action at the
-- customer's address — arrival, proof and occurrence).
--
--   "distance_m"        metres from the phone's position to the address
--                       point, as the server computed it; null when either
--                       side had no coordinate.
--   "accuracy_m"        the phone's reported accuracy of that position.
--   "geofence_outcome"  INSIDE, OUTSIDE or NOT_EVALUATED (no address point,
--                       accuracy worse than the radius, a stale position, or
--                       the company has the geofence off). OUTSIDE on a row is
--                       the "fora do raio" flag the tower and the timeline
--                       show: an ALERT confirmed by the driver, or a queued
--                       offline submission the server accepted (it never
--                       refuses one).
--
-- Stored on the event so a replay answers with what was decided then, and so
-- a later change of the radius does not rewrite the past.
--
-- Expand-safe: three nullable columns with no default (catalog-only) that the
-- serving image never reads or writes; the enum type is new (20261102120000).
-- No index: read with the event (by delivery, by tenant and date).

SET lock_timeout = '5s';

ALTER TABLE "delivery_event"
  ADD COLUMN IF NOT EXISTS "distance_m" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "accuracy_m" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "geofence_outcome" "GeofenceOutcome";
