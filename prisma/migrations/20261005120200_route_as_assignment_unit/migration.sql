-- The route as the unit of assignment (decision 14.7; design:
-- docs/desenho/rota-como-unidade-de-atribuicao.md §3 and §10).
--
-- Additive only: no column removed, nothing rewritten. ADD COLUMN with a
-- constant default is metadata-only on PostgreSQL 11+. route and delivery were
-- created after the production baseline (the delivery module has not
-- shipped). The ROUTE_ADDED / ROUTE_REMOVED event types are in
-- 20261005120000_meeting_enum_values. GeocodeCache (geocoding, slice 2) is
-- left out on purpose until the owner picks a provider (design §12, §13).

-- ---------------------------------------------------------------------------
-- route: the plan version and the create's idempotency key
-- ---------------------------------------------------------------------------

-- plan_version starts at 0 on every route; client_submission_id is null on
-- every existing one (the panel's Idempotency-Key, IDEMP-14).
ALTER TABLE "route"
  ADD COLUMN "plan_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "client_submission_id" TEXT;

-- Unique per company, like delivery's: a null key never collides.
CREATE UNIQUE INDEX "route_businessId_client_submission_id_key"
  ON "route"("businessId", "client_submission_id");

-- ---------------------------------------------------------------------------
-- delivery: where the address is, for the route map
-- ---------------------------------------------------------------------------

CREATE TYPE "DeliveryGeoSource" AS ENUM ('MANUAL', 'GEOCODER');

-- No backfill in phase 1: the map lists deliveries without a point under
-- "sem localização" with "Fixar no mapa". No index: read only with the stop
-- (by routeId) or the delivery (by id).
ALTER TABLE "delivery"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "geo_source" "DeliveryGeoSource",
  ADD COLUMN "geo_updated_at" TIMESTAMP(3);
