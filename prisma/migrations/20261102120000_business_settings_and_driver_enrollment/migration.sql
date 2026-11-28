-- Two new tables and the enums the plan of 02/11/2026 (Fase 2) writes
-- against: the company's own settings (M1) and the driver's one-time access
-- code (D3). Additive only: nothing the serving image reads changes.
--
-- The enums are new types, unknown to the serving image, so a value is never
-- read by a client that cannot parse it (the enum-expand rule is about NEW
-- VALUES on a type that image already reads).
--
--   ChecklistRequirement  when the driver's route asks for the vehicle
--                         checklist (C4): never, at departure, at arrival or
--                         at both.
--   GeofenceMode          what an action at the customer's address does when
--                         the phone is outside the radius (E3/E4): nothing,
--                         ask and flag, or refuse.
--   ChecklistPhase        which moment of a route a checklist answered (C4/F3);
--                         STANDALONE for every checklist made outside a route.
--   GeofenceOutcome       where an action at the customer's address was made,
--                         relative to the radius (E2/E4).
--
-- The foreign keys to "business" and "user" take a brief lock on those hot
-- tables, hence the lock_timeout: a deploy that waits fails and retries
-- instead of queueing every login behind it.

SET lock_timeout = '5s';

CREATE TYPE "ChecklistRequirement" AS ENUM ('NONE', 'ROUTE_START', 'ROUTE_END', 'ROUTE_START_AND_END');

CREATE TYPE "GeofenceMode" AS ENUM ('DISABLED', 'ALERT', 'BLOCK');

CREATE TYPE "ChecklistPhase" AS ENUM ('STANDALONE', 'ROUTE_START', 'ROUTE_END');

CREATE TYPE "GeofenceOutcome" AS ENUM ('INSIDE', 'OUTSIDE', 'NOT_EVALUATED');

-- ---------------------------------------------------------------------------
-- business_settings: what a company's admin decides for its own operation
-- ---------------------------------------------------------------------------

-- One row per company at most, written on the first save: a company without
-- one reads the defaults below (the same constants the code applies), so no
-- backfill is needed and a new company needs no seed. The radius is bounded
-- in the database too, not only in the request schema: a value outside it
-- would weaken the control the setting exists for.
CREATE TABLE "business_settings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "checklist_requirement" "ChecklistRequirement" NOT NULL DEFAULT 'NONE',
    "arrival_geofence_mode" "GeofenceMode" NOT NULL DEFAULT 'DISABLED',
    "arrival_geofence_radius_m" INTEGER NOT NULL DEFAULT 500,
    "updatedById" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_settings_geofence_radius_chk"
      CHECK ("arrival_geofence_radius_m" BETWEEN 50 AND 5000)
);

CREATE UNIQUE INDEX "business_settings_businessId_key" ON "business_settings"("businessId");

-- The SET NULL when the user who saved last is deleted.
CREATE INDEX "business_settings_updatedById_idx" ON "business_settings"("updatedById");

ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- driver_enrollment_token: the QR code (and its short code) a manager shows
-- ---------------------------------------------------------------------------

-- Only hashes: the QR's opaque token and the 8-character code are shown once
-- and never stored (SHA-256 hex, like the password reset token). One row per
-- driver login (unique userId): issuing a new code replaces the previous one,
-- so at most one is ever live and the table never outgrows the drivers.
-- `attempts` counts the refused presentations of this code; `device_id` is
-- the phone that consumed it, which the session it opened is bound to (D4).
CREATE TABLE "driver_enrollment_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "code_hash" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "createdById" TEXT,
    "device_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_enrollment_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_enrollment_token_userId_key" ON "driver_enrollment_token"("userId");

CREATE UNIQUE INDEX "driver_enrollment_token_token_hash_key" ON "driver_enrollment_token"("token_hash");

-- A null code never collides (a token issued without one).
CREATE UNIQUE INDEX "driver_enrollment_token_code_hash_key" ON "driver_enrollment_token"("code_hash");

-- The cascade when a company is deleted, and the SET NULL when the manager
-- who issued it is.
CREATE INDEX "driver_enrollment_token_businessId_idx" ON "driver_enrollment_token"("businessId");

CREATE INDEX "driver_enrollment_token_createdById_idx" ON "driver_enrollment_token"("createdById");

ALTER TABLE "driver_enrollment_token" ADD CONSTRAINT "driver_enrollment_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_enrollment_token" ADD CONSTRAINT "driver_enrollment_token_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_enrollment_token" ADD CONSTRAINT "driver_enrollment_token_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
