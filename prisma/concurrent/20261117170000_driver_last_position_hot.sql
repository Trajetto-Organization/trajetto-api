-- driver_last_position with HOT updates (plano-escala F2-13): the index on
-- ("businessId") alone, so a flush's rewrite changes no indexed column,
-- built before the old ("businessId", "recorded_at" DESC) is dropped, so
-- the tower always has one. The fillfactor is in the migration of the same
-- name.
-- requires-table: driver_last_position

CREATE INDEX CONCURRENTLY IF NOT EXISTS "driver_last_position_businessId_idx" ON "driver_last_position" ("businessId");

DROP INDEX CONCURRENTLY IF EXISTS "driver_last_position_businessId_recorded_at_idx";
