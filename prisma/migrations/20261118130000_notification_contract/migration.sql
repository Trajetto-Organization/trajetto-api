-- ----------------------------------------------------------------------------
-- The bell (notification) loses its foreign keys and the unique on
-- deliveryId, on a new database only (plano-escala F5-15)
-- ----------------------------------------------------------------------------
-- The bell becomes partitioned by month on its id (prisma/post-deploy/
-- 20-notification-partition-swap.sql), and a month leaves whole. A
-- partitioned table cannot hold a unique that leaves out its key, and a
-- foreign key to "user" and business would hold every drop. The code stands
-- without them: a notification's id is its delivery's (F5-14), so a retried
-- IN_APP meets the primary key, and deleting a user or a company takes its
-- bell rows in SQL (src/shared/notifications/queue-row-cleanup.ts). What
-- goes: notification_userId_fkey, notification_businessId_fkey and
-- notification_deliveryId_key (no read looks a notification up by
-- deliveryId).
--
-- contract-phase: the image from before the plan deletes the bell through
-- the cascades and dedupes a retried IN_APP by the unique, during the
-- rolling deploy and after a rollback, and the plan ships in one release.
-- So on a database that is serving (it has a company) this file does
-- nothing, and the contraction is prisma/post-deploy/07-notification-contract.sql,
-- which waits until every live process announces
-- notification-partition-agnostic-v1 and no delivery the previous image may
-- have written a bell row for is still in flight. Here it runs only on a
-- database with no company (the E2E template, Prisma's shadow database,
-- `yarn dev` from scratch), so the migrations' history ends where
-- prisma/schema.prisma does.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "business" LIMIT 1) THEN
    ALTER TABLE "notification" DROP CONSTRAINT IF EXISTS "notification_userId_fkey";
    ALTER TABLE "notification" DROP CONSTRAINT IF EXISTS "notification_businessId_fkey";

    DROP INDEX IF EXISTS "notification_deliveryId_key";
  END IF;
END $$;
