-- Where a checklist was made (owner's test of the driver app, 05/11/2026:
-- every checklist the app sent showed "Web" in the panel).
--
-- vehicle_checklist never had the column that fuel, fine and service_order
-- have (20251118211255). The app sent `created_from`, the repository dropped
-- it before the INSERT (spread in, it had failed every app checklist with a
-- 500), and the web, finding no field, fell back to "Web". From this release
-- the column is stored: a driver's checklist is MOBILE_APP whatever its body
-- says, and one whose body names no origin is MOBILE_APP when it carries an
-- idempotency key, which only the app sends (shared/vehicle/record-origin.ts).
--
--   "created_from"  MOBILE_APP or WEB_DASHBOARD. WEB_DASHBOARD by default:
--                   what the web's form gets (it sends no origin and no key),
--                   and what every INSERT of the serving image gets, since its
--                   client does not know the column.
--
-- Expand-safe: a NOT NULL column with a constant default (catalog-only on
-- PostgreSQL 11+) that the serving image never reads or writes, of an enum
-- type that exists since 20251118211255. Rolled back, the previous image
-- writes WEB_DASHBOARD again for every checklist, the app's included, until
-- this release returns.
--
-- Alone in its migration on purpose: ADD COLUMN takes an ACCESS EXCLUSIVE
-- lock on vehicle_checklist that lasts until the transaction commits, and the
-- API's sessions run with lock_timeout=5s, so every checklist read and write
-- queued behind it fails with a 500 (55P03) after 5 s rather than waiting.
-- Here that lock is held for the catalog change only; the backfill, which
-- reads the whole activity trail, is the next migration
-- (20261105120100_vehicle_checklist_created_from_backfill), in a transaction
-- of its own that never takes it.

SET lock_timeout = '5s';

ALTER TABLE "vehicle_checklist"
  ADD COLUMN IF NOT EXISTS "created_from" "RecordOrigin" NOT NULL DEFAULT 'WEB_DASHBOARD';
