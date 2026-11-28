-- A second refuelling of the same vehicle within 30 minutes, flagged for the
-- office (owner, 05/11/2026: "o ideal não é a pessoa conseguir registrar
-- abastecimento toda hora"). No cooldown: several refuellings a day are
-- legitimate on a long haul, as fleet tools that do this (Samsara, Geotab)
-- assume. Instead the app shows the vehicle's last refuelling and asks the
-- driver to confirm a second one within the window and say why; the API
-- refuses an unconfirmed one from a build that asks (contract 5 on, 409
-- FUEL_RECENT_REFUEL), and stores the alert on every refuelling it records,
-- whoever sent it (modules/fuel/usecases/fuel-rules.ts).
--
--   "FuelAlert"                  the enum of what the office should look at;
--                                RECENT_REFUEL only for now.
--   "alerts"                     the record's alerts, decided inside the
--                                create's serializable transaction (two
--                                refuellings sent at once are still flagged)
--                                and again by an edit that moves the date or
--                                the vehicle. NOT NULL, empty by default.
--   "recent_refuel_reason"       the driver's reason when they confirmed
--                                (3 to 300 characters); kept when an edit
--                                clears the alert.
--   "recent_refuel_previous_at"  the other refuelling's refueling_date. A
--                                historical fact: deleting that refuelling
--                                leaves the alert and this date as they are.
--
-- No backfill: the refuellings recorded before this release are not
-- flagged, even the ones that would have been. The alert says what the API
-- saw when the record arrived, and the filter of the list starts from here.
--
-- Expand-safe: a new enum type no running image reads, created idempotently
-- (skipped on duplicate_object, so it can be created by hand first); one NOT
-- NULL column with a constant DEFAULT (an empty array: catalog-only on
-- PostgreSQL 11+, no rewrite and no scan) and two nullable columns, none of
-- which the serving image reads or writes. Its INSERTs leave them out and
-- get an empty "alerts", so the refuellings it records in the rollout, or
-- after a rollback, are not flagged. fuel is written on every refuelling:
-- one table in this file, under lock_timeout, and the ACCESS EXCLUSIVE lock
-- of ADD COLUMN lasts for the catalog change only.

DO $$ BEGIN
  CREATE TYPE "FuelAlert" AS ENUM ('RECENT_REFUEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

SET lock_timeout = '5s';

ALTER TABLE "fuel"
  ADD COLUMN IF NOT EXISTS "alerts" "FuelAlert"[] NOT NULL DEFAULT ARRAY[]::"FuelAlert"[],
  ADD COLUMN IF NOT EXISTS "recent_refuel_reason" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "recent_refuel_previous_at" TIMESTAMP(3);
