-- Where a delivery's address is, found by the geocoder (plan of 02/11/2026,
-- item E1; decision D15): the point the company's geofence measures from and
-- the route map draws the stop at, for every delivery created by the form,
-- the NF-e XML, the spreadsheet or the public API — none of which carries a
-- coordinate. A background job (geocode-deliveries) asks the Nominatim-
-- compatible provider already configured for the proof's reverse lookup,
-- never the request that created the delivery.
--
--   "geo_precision"         the level the provider reached: ADDRESS (the
--                           house number) or STREET get the point
--                           (geo_source = GEOCODER, an existing value);
--                           NEIGHBORHOOD or CITY never get one — a district's
--                           centre is nobody's door, so the geofence reads it
--                           as "não avaliável" and the map as "sem
--                           localização". Meaningless on a MANUAL point.
--   "geocode_status"        null = not tried yet; RESOLVED, COARSE,
--                           NOT_FOUND, or FAILED (retried a few times).
--   "geocode_attempted_at"  the last claim; doubles as the claim's lease, so
--                           a replica that dies mid-run frees its rows.
--   "geocode_attempts"      how many claims the address had.
--
-- update-delivery clears all four together with the point when the address
-- changes, so the new address is geocoded again; a MANUAL point is never
-- overwritten (the job writes only WHERE geo_source IS NULL).
--
-- Expand-safe: two new enum types (no running image reads them), three
-- nullable columns and one NOT NULL column with a constant DEFAULT — all
-- catalog-only on Postgres 11+ — that the serving image never reads or
-- writes. delivery is hot: one table in this file, under lock_timeout.
--
-- The index serves the job's claim, newest first, over the open deliveries
-- still without a point and not settled by the geocoder; raw SQL because
-- Prisma cannot declare a partial index (pinned in raw-sql-objects.test.ts).
-- Its predicate reads geocode_status, a column this file adds, so on a
-- database with volume pre-build it by hand in this order: (1) the two DO
-- blocks below (each CREATE TYPE, idempotent); (2) the ALTER TABLE below,
-- every ADD COLUMN IF NOT EXISTS (catalog-only); (3) CREATE INDEX
-- CONCURRENTLY IF NOT EXISTS with this name and this predicate, outside a
-- transaction; (4) check that pg_index.indisvalid is true for it (a failed
-- CONCURRENTLY build leaves an invalid index behind: drop it and build
-- again). The migration then does nothing: the types are skipped on
-- duplicate_object, the columns and the index on IF NOT EXISTS.

DO $$ BEGIN
  CREATE TYPE "DeliveryGeoPrecision" AS ENUM ('ADDRESS', 'STREET', 'NEIGHBORHOOD', 'CITY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryGeocodeStatus" AS ENUM ('RESOLVED', 'COARSE', 'NOT_FOUND', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

SET lock_timeout = '5s';

ALTER TABLE "delivery"
  ADD COLUMN IF NOT EXISTS "geo_precision" "DeliveryGeoPrecision",
  ADD COLUMN IF NOT EXISTS "geocode_status" "DeliveryGeocodeStatus",
  ADD COLUMN IF NOT EXISTS "geocode_attempted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "geocode_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "delivery_geocode_pending_idx"
  ON "delivery" ("created_at")
  WHERE "latitude" IS NULL
    AND "geo_source" IS NULL
    AND ("geocode_status" IS NULL OR "geocode_status" = 'FAILED')
    AND "status" IN ('PENDING', 'IN_TRANSIT');
