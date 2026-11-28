-- ----------------------------------------------------------------------------
-- process_heartbeat: what each image says the realtime runs (plano-escala
-- F3-31c, F3-34)
-- ----------------------------------------------------------------------------
-- The deploy keeps trajetto-realtime on its build while what it runs did
-- not change (the image's trajetto.realtime-source and
-- trajetto.contract-epoch labels match the new image's). The fleet's alert
-- mixed-versions read that realtime, on the previous commit, as a role left
-- on the old build, and paged 30 min after almost every release. Every
-- process now writes the two labels of its image (APP_REALTIME_SOURCE and
-- APP_CONTRACT_EPOCH, src/shared/build-info.ts) in its row, and the alert
-- leaves out a realtime whose two match the newest commit's.
--
-- Expand only: two nullable columns, with no default, on a handful of rows
-- (one per process); a rollback leaves them null and unread. The ALTER is
-- a catalogue change, but it waits for the ACCESS EXCLUSIVE lock behind the
-- beats in flight: lock_timeout keeps it from holding the beats behind it.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "process_heartbeat" ADD COLUMN "realtime_source" TEXT,
ADD COLUMN "contract_epoch" INTEGER;
