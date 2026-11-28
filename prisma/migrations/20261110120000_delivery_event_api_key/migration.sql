-- Which API key cancelled a delivery through the public API (plan of
-- 02/11/2026, L9; decision D49). POST /integration/v1/deliveries/:id/cancel
-- writes its STATUS_CHANGE with actor INTEGRATION and no user; this column
-- names the key, so the delivery's trail reads the key's name ("ERP
-- Protheus") and not a bare "integração" (owner's decision). Null on every
-- other event, and on every existing one.
--
--   "apiKeyId"  the key that acted. SET NULL like delivery."apiKeyId": keys
--               are revoked, not deleted, and the event is the record.
--
-- Expand-safe: a nullable column with no default (catalog-only) that the
-- serving image never reads or writes (its Prisma client names its columns).
-- Almost every event is null here, so the index is partial; it serves the
-- SET NULL from "api_key".
--
-- The foreign key is NOT VALID. Validating it would read the whole table
-- under SHARE ROW EXCLUSIVE (every arrival, proof and status change of every
-- company waits; lock_timeout only bounds the wait for the lock): a column
-- with no statistics yet is planned as 99.5% non-null, so the check reads
-- the table, not the partial index. There is nothing to check either: every row
-- that exists now is null, because the serving image never writes the
-- column. Rows written from here on are checked like under any foreign key,
-- and ON DELETE SET NULL acts on all of them. Prisma does not track the
-- flag; `ALTER TABLE "delivery_event" VALIDATE CONSTRAINT
-- "delivery_event_apiKeyId_fkey"` (SHARE UPDATE EXCLUSIVE, writes go on) is
-- optional and changes nothing it enforces.
--
-- One hot table. Plain CREATE INDEX for the reason given in
-- 20261007120000_db_perf_indexes (Prisma runs this file in a transaction,
-- where CONCURRENTLY is refused). On a database with volume, before
-- promoting, create the column and the index by hand, in this order:
--   ALTER TABLE "delivery_event" ADD COLUMN IF NOT EXISTS "apiKeyId" TEXT;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "delivery_event_apiKeyId_partial_idx"
--     ON "delivery_event" ("apiKeyId") WHERE "apiKeyId" IS NOT NULL;
-- and confirm `indisvalid`. The first two statements below then do nothing,
-- and only the foreign key is added here, without reading the table.

SET lock_timeout = '5s';

ALTER TABLE "delivery_event" ADD COLUMN IF NOT EXISTS "apiKeyId" TEXT;

CREATE INDEX IF NOT EXISTS "delivery_event_apiKeyId_partial_idx"
  ON "delivery_event" ("apiKeyId")
  WHERE "apiKeyId" IS NOT NULL;

ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;
