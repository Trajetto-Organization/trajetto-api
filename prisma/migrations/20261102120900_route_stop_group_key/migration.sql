-- Which stops of a route are the same visit (plan of 02/11/2026, item B6;
-- decision D37): one customer message per stop, not one per NF-e.
--
-- A hash of the normalized address with the recipient's document or phone,
-- written when the stop is added and recomputed when the delivery's address
-- is edited (K9). Stops of one route with the same key are siblings: "a
-- caminho" marks them together and "entregue"/"insucesso" are merged into one
-- message. Null on every existing stop, which is a group of its own — exactly
-- today's one message per delivery.
--
-- Expand-safe: a nullable column with no default (catalog-only) that the
-- serving image never reads or writes. The index answers "the siblings of
-- this stop in this route"; route_stop is hot, so on a database with volume
-- build it first by hand: the column with the ALTER TABLE below (its
-- ADD COLUMN IF NOT EXISTS, catalog-only; the index reads it), then
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS with this name, and check that
-- pg_index.indisvalid is true for it. This file then does nothing.

SET lock_timeout = '5s';

ALTER TABLE "route_stop" ADD COLUMN IF NOT EXISTS "stop_group_key" TEXT;

CREATE INDEX IF NOT EXISTS "route_stop_routeId_stop_group_key_idx" ON "route_stop"("routeId", "stop_group_key");
