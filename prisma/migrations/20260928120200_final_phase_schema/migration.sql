-- The columns and tables of the final phase (docs/decisoes-fase-final-2026-09.md),
-- in one expand step, so the use cases of every decision can be written
-- against a schema that already has them.
--
-- Expand-safe throughout: every new column is nullable or has a default, and
-- every new table, enum and index is unknown to the image that is serving.
-- The previous client inserts without the columns it does not know and
-- selects only the ones it does.

-- ---------------------------------------------------------------------------
-- New enums
-- ---------------------------------------------------------------------------

-- CNH classes, combined ones included (decision 8.5).
CREATE TYPE "CnhCategory" AS ENUM ('A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE');

-- The tower's answer to an occurrence that requires it (decision 6.3).
CREATE TYPE "OccurrenceAuthorizationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DENIED', 'SUPERSEDED');

-- Driver breaks (decision 6.1).
CREATE TYPE "DriverPauseKind" AS ENUM ('MEAL', 'REST', 'OTHER');

-- ---------------------------------------------------------------------------
-- The carrier's time zone (decision 1.1)
-- ---------------------------------------------------------------------------

-- IANA. Every existing carrier runs on Brasilia time today, which is exactly
-- what the default says; a carrier in MT, MS, RO, AM, AC or RR changes it.
ALTER TABLE "business" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

-- ---------------------------------------------------------------------------
-- Fleet (decisions 8.4 and 8.5)
-- ---------------------------------------------------------------------------

-- Who is paid (a supplier or free text), what for, which vehicle carries the
-- cost, the document number, and who typed the bill in. All nullable: legacy
-- bills have none of them.
ALTER TABLE "account_payable"
  ADD COLUMN "supplierId" TEXT,
  ADD COLUMN "vehicleId" TEXT,
  ADD COLUMN "payee_name" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "document_number" TEXT,
  ADD COLUMN "createdById" TEXT;

-- One per foreign key: the bills of a payee or of a vehicle, and the SET NULL
-- when either (or the user) is deleted. account_payable is a carrier's
-- financial table, small enough for a plain build.
CREATE INDEX "account_payable_supplierId_idx" ON "account_payable"("supplierId");
CREATE INDEX "account_payable_vehicleId_idx" ON "account_payable"("vehicleId");
CREATE INDEX "account_payable_createdById_idx" ON "account_payable"("createdById");

ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "account_payable" ADD CONSTRAINT "account_payable_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The licence class and expiry on the driver, the class a vehicle type needs.
-- The expiry is a civil date.
ALTER TABLE "driver"
  ADD COLUMN "cnh_category" "CnhCategory",
  ADD COLUMN "cnh_expires_at" DATE;

ALTER TABLE "vehicle_type" ADD COLUMN "required_cnh_category" "CnhCategory";

-- ---------------------------------------------------------------------------
-- Routes and stops (decisions 6.4 and 6.5)
-- ---------------------------------------------------------------------------

ALTER TABLE "route" ADD COLUMN "destination" TEXT;

ALTER TABLE "route_stop" ADD COLUMN "on_the_way_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Occurrence form and tower authorization (decisions 6.2 and 6.3)
-- ---------------------------------------------------------------------------

ALTER TABLE "occurrence_type"
  ADD COLUMN "form_fields" JSONB,
  ADD COLUMN "form_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "requires_authorization" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- Every report that exists was applied at once, which is NOT_REQUIRED.
ALTER TABLE "delivery_occurrence"
  ADD COLUMN "form_answers" JSONB,
  ADD COLUMN "form_version" INTEGER,
  ADD COLUMN "authorization_status" "OccurrenceAuthorizationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "authorizedById" TEXT,
  ADD COLUMN "authorized_at" TIMESTAMP(3),
  ADD COLUMN "authorization_note" TEXT,
  ADD COLUMN "escalated_at" TIMESTAMP(3);

ALTER TABLE "delivery_occurrence" ADD CONSTRAINT "delivery_occurrence_authorizedById_fkey"
  FOREIGN KEY ("authorizedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The tower's queue and the 10-minute escalation sweep read only what still
-- waits: a handful of rows in a table that only grows. Partial, so raw SQL
-- (Prisma cannot declare it); the literal matches the predicate the queries
-- spell, which is what lets the planner use it.
CREATE INDEX "delivery_occurrence_pending_authorization_idx"
  ON "delivery_occurrence" ("businessId", "created_at")
  WHERE "authorization_status" = 'PENDING';

-- The SET NULL when a user is deleted. Only authorized reports carry the
-- column, so a full btree would be almost all nulls.
CREATE INDEX "delivery_occurrence_authorizedById_partial_idx"
  ON "delivery_occurrence" ("authorizedById")
  WHERE "authorizedById" IS NOT NULL;

-- The occurrence an OCCURRENCE event records (TWR-6). Same shape as reasonId.
ALTER TABLE "delivery_event" ADD COLUMN "occurrenceId" TEXT;

ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_occurrenceId_fkey"
  FOREIGN KEY ("occurrenceId") REFERENCES "delivery_occurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "delivery_event_occurrenceId_partial_idx"
  ON "delivery_event" ("occurrenceId")
  WHERE "occurrenceId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Public API writes (decision 5.10)
-- ---------------------------------------------------------------------------

-- The key that created a delivery through POST /integration/v1/deliveries:
-- the origin INTEGRATION, and which integration. Its Idempotency-Key reuses
-- delivery.client_submission_id (unique per company). Almost every delivery
-- comes from the panel or an import, so the index is partial.
ALTER TABLE "delivery" ADD COLUMN "apiKeyId" TEXT;

ALTER TABLE "delivery" ADD CONSTRAINT "delivery_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "delivery_apiKeyId_partial_idx"
  ON "delivery" ("apiKeyId")
  WHERE "apiKeyId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Chat linked to a route (decision 6.7)
-- ---------------------------------------------------------------------------

ALTER TABLE "chat_message" ADD COLUMN "routeId" TEXT;

ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A route's messages in order (the route screen and the thread filtered by
-- route), and the SET NULL when reversing an import deletes its routes.
-- Partial for the reason chat_message_delivery_idx is: most messages carry no
-- route (20260919120000_chat_delete_path_indexes).
CREATE INDEX "chat_message_route_idx"
  ON "chat_message" ("routeId", "created_at")
  WHERE "routeId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Driver pauses (decision 6.1)
-- ---------------------------------------------------------------------------

CREATE TABLE "driver_pause" (
    "id" TEXT NOT NULL,
    "kind" "DriverPauseKind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "start_latitude" DOUBLE PRECISION,
    "start_longitude" DOUBLE PRECISION,
    "end_latitude" DOUBLE PRECISION,
    "end_longitude" DOUBLE PRECISION,
    "note" TEXT,
    "start_submission_id" TEXT NOT NULL,
    "end_submission_id" TEXT,
    "driverId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "routeId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_pause_pkey" PRIMARY KEY ("id")
);

-- Each gesture of the phone lands once, however often the outbox resends it.
CREATE UNIQUE INDEX "driver_pause_businessId_start_submission_id_key"
  ON "driver_pause"("businessId", "start_submission_id");
CREATE UNIQUE INDEX "driver_pause_businessId_end_submission_id_key"
  ON "driver_pause"("businessId", "end_submission_id");

-- The report (a company's day, a driver's day), the RESTRICT check when a
-- driver is deleted, and the SET NULL when a route is.
CREATE INDEX "driver_pause_businessId_started_at_idx" ON "driver_pause"("businessId", "started_at");
CREATE INDEX "driver_pause_driverId_started_at_idx" ON "driver_pause"("driverId", "started_at");
CREATE INDEX "driver_pause_routeId_idx" ON "driver_pause"("routeId");

-- At most ONE open pause per driver. Two taps on "start" from two phones, or
-- a start replayed under a new key after a reinstall, would otherwise leave
-- two pauses running and every duration after them wrong. No code path checks
-- this before writing: the P2002 is the check. Partial, so raw SQL.
CREATE UNIQUE INDEX "driver_pause_one_open_idx"
  ON "driver_pause" ("driverId")
  WHERE "ended_at" IS NULL;

-- RESTRICT on the driver, like fuel, fines and routes: a pause is a record of
-- the legal working day. The tenant cascades as everywhere else.
ALTER TABLE "driver_pause" ADD CONSTRAINT "driver_pause_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "driver_pause" ADD CONSTRAINT "driver_pause_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_pause" ADD CONSTRAINT "driver_pause_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;
