-- The same geofence record as delivery_event's (20261102120600), for an
-- occurrence (plan of 02/11/2026, items E3/E4; the owner's call on D13: the
-- radius covers the occurrence too). Under BLOCK an occurrence is never
-- refused — the driver may need to report exactly that they could not reach
-- the address — so OUTSIDE here is a flag for review, shown in the
-- "Ocorrências" list, which reads this table without joining the events.
--
-- Expand-safe: three nullable columns with no default (catalog-only) that the
-- serving image never reads or writes; the enum type is new (20261102120000).

SET lock_timeout = '5s';

ALTER TABLE "delivery_occurrence"
  ADD COLUMN IF NOT EXISTS "distance_m" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "accuracy_m" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "geofence_outcome" "GeofenceOutcome";
