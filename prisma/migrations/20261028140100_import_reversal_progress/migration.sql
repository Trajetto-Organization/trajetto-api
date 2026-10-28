-- The undo of an upload runs in batches, and its progress lives on the record.
--
-- Reversing an upload ran in one interactive transaction with Prisma's 15 s
-- timeout: a 2,000-delivery upload took 29 s to undo and failed every time,
-- so a 20,000-row upload could never be taken back. The undo now commits
-- 500 deliveries per transaction (services/import-reversal.ts), and these two
-- columns are what make that resumable and single-run:
--
--   "reversal"             what the committed batches removed and kept, and
--                          the result once the last one flips the upload to
--                          REVERSED; a retry after a crash adds to it;
--   "reversal_started_at"  the lease of the run undoing it now, claimed by a
--                          conditional UPDATE and re-checked by every batch.
--                          Its heartbeat is the existing "updated_at".
--
-- Expand-safe: two nullable columns with no default (a catalog-only change)
-- that the serving image never reads or writes. After a rollback they stay,
-- unused; the previous image's single-transaction undo still works.

SET lock_timeout = '5s';

ALTER TABLE "import" ADD COLUMN IF NOT EXISTS "reversal" JSONB;
ALTER TABLE "import" ADD COLUMN IF NOT EXISTS "reversal_started_at" TIMESTAMP(3);
