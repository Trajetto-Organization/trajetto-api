-- delivery_event.txid: the commit-order stamp of the integration feed
-- (plano-escala F2-03).
--
-- /integration/v1/events walks a tenant's events by id (uuid v7, minted by
-- the API process when the row is built). Ids are not commit order: a
-- transaction that minted its id first and committed last lands BEHIND a
-- poller that already read past it, and the event is skipped for good.
-- The feed of wave 10 (F2-05) walks by the writing transaction's id
-- instead, and serves only what is below the oldest transaction still open
-- (pg_snapshot_xmin), so nothing can commit behind its cursor. That needs
-- the transaction's id on each row: this column, filled by the DEFAULT
-- below in the transaction that inserts the row, the same value for every
-- event of one transaction.
--
-- pg_current_xact_id() is the 64-bit xid8 (epoch and xid), so it never
-- wraps; text and back to bigint because Postgres has no direct cast from
-- xid8. The rows written before this keep NULL, read as 0 by the feed: the
-- whole old history sorts before every new event, in id order among
-- itself, which is the order the legacy cursor already walked.
--
-- The schema declares it `@ignore` (prisma/schema.prisma): Prisma never
-- reads or writes it, and a BigInt in a response would break the JSON.
--
-- Expand-safe: ADD COLUMN IF NOT EXISTS with no default is catalog-only on
-- Postgres 11+; SET DEFAULT applies to new rows only and rewrites nothing.
-- The serving image never names the column, and its inserts get the
-- DEFAULT too, so a rolling deploy and a rollback both keep stamping.
-- delivery_event is hot: one table in this file, under lock_timeout.
--
-- The feed's index ("businessId", COALESCE("txid", 0), "id") reads the
-- column this file adds. prisma/concurrent/20261117140000_delivery_event_feed.sql
-- builds it with CREATE INDEX CONCURRENTLY right after the migrations (the
-- second pass of the release step, prisma/concurrent/README.md), so the
-- block below builds it only on an empty table (a new database: the E2E
-- template, `yarn dev`, Prisma's shadow database). By hand on a database
-- with volume: (1) the ALTER TABLE ... ADD COLUMN IF NOT EXISTS and SET
-- DEFAULT below; (2) CREATE INDEX CONCURRENTLY IF NOT EXISTS with this
-- name and these columns, outside a transaction; (3) check that
-- pg_index.indisvalid is true for it.

SET lock_timeout = '5s';

ALTER TABLE "delivery_event" ADD COLUMN IF NOT EXISTS "txid" BIGINT;

ALTER TABLE "delivery_event" ALTER COLUMN "txid" SET DEFAULT ((pg_current_xact_id())::text)::bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "delivery_event" LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "delivery_event_feed_idx" ON "delivery_event" ("businessId", (COALESCE("txid", 0)), "id");
  END IF;
END $$;
