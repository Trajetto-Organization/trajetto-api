-- ----------------------------------------------------------------------------
-- provider_quota_day: a provider's day, counted per scope (plano-escala F2-32)
-- ----------------------------------------------------------------------------
-- The geocoder's day lived in a Redis key: an eviction gave the provider's
-- quota back for free, and a key that is money or a contract must not
-- vanish with one (decision D23). One row per provider, scope and UTC day,
-- taken one unit at a time by an INSERT ... ON CONFLICT DO UPDATE that only
-- counts below the limit, so 50 parallel takes with a limit of 10 grant
-- exactly 10. The geocoder's scopes are "geocoding-job", "address-search",
-- "address-search:<businessId>" and "proof-reverse"; wave 13 adds
-- "whatsapp:<businessId>" to the same table and the same primary key.
--
-- Expand only: a new table the serving release never reads. During the
-- rolling deploy the new image also writes the old Redis key, seeded with
-- GREATEST of both, so the previous image keeps counting the same day; a
-- rollback leaves the table unused. A few rows a day (one per scope, one
-- per company that searched), purged after 35 days by purge-ops-series.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "provider_quota_day" (
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_quota_day_pkey" PRIMARY KEY ("provider","scope","day")
);

-- CreateIndex
CREATE INDEX "provider_quota_day_day_idx" ON "provider_quota_day"("day");
