-- ----------------------------------------------------------------------------
-- The scheduled purge of a company (plano-escala F3-25)
-- ----------------------------------------------------------------------------
-- Deleting a company was one DELETE that only worked on an empty one, and
-- `is_active` (deactivation) is what a company gets for an unpaid bill: it
-- blocks the access and keeps everything. The purge is a separate, explicit
-- action of a MASTER, with a state machine on the company:
--
--  - purge_state NULL: never scheduled. Every company of today, active or
--    inactive, stays NULL: there is NO backfill, so a company deactivated
--    for any reason before this release can never be purged by it;
--  - SCHEDULED: the MASTER scheduled it; the company is inactive since
--    deactivated_at, and its data goes on purge_after
--    (TENANT_PURGE_AFTER_DAYS later). Reactivating is allowed only here;
--  - PURGING: the TENANT_OFFBOARD job started deleting (F3-26a): no way
--    back, and a reactivation is refused;
--  - PURGED: done.
--
-- Expand only: three nullable columns and a new type the serving release
-- never reads or writes. A rollback leaves them NULL and unused.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "BusinessPurgeState" AS ENUM ('SCHEDULED', 'PURGING', 'PURGED');

-- AlterTable
ALTER TABLE "business" ADD COLUMN "purge_state" "BusinessPurgeState",
ADD COLUMN "deactivated_at" TIMESTAMP(3),
ADD COLUMN "purge_after" TIMESTAMP(3);
