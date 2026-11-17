-- ----------------------------------------------------------------------------
-- delivery_event_part: the partitioned shell of the delivery trail
-- (plano-escala F2-16)
-- ----------------------------------------------------------------------------
-- delivery_event grows by a few rows per delivery for good: at the 5M scale
-- some 15 million a month, read by tenant and by delivery, never purged.
-- It moves to a table partitioned by month on its id (a uuid v7, so ids
-- sort in time) at the copy window of wave 11 (F2-17): an INSERT ... SELECT
-- into this shell, then a rename of each table. This file only makes the
-- shell, empty, so the window has nothing left to build under its lock:
--
-- - the same columns, defaults and NOT NULLs as delivery_event, by LIKE
--   (a column added to delivery_event before the window must be added here
--   too: tests/E2E/delivery-event-partition-shell.test.ts compares them);
-- - the primary key on id, the partition key;
-- - a legacy partition FROM (MINVALUE) up to the first id of this month,
--   where the copy puts the history, and one partition a month from this
--   one to three ahead; the nightly partition-maintenance job keeps three
--   months made from then on (src/shared/database/partitions.ts), and the
--   release step makes trajetto_partitions their owner
--   (infra/sql/10-partitions.sql);
-- - every index of delivery_event, named *_part_* (the window renames them
--   to the canonical names), the integration feed's index included. One
--   difference, on purpose: client_submission_id is a plain index here. A
--   partitioned table cannot hold a unique index without its partition
--   key, and the key's uniqueness lives in delivery_event_submission
--   (F2-14);
-- - the businessId statistics target of delivery_event (F2-22).
--
-- The six foreign keys come one per migration, right after this one: each
-- takes SHARE ROW EXCLUSIVE on the table it references (delivery, user,
-- route, delivery_occurrence, api_key, status_change_reason), and inside
-- one transaction those locks would all be held until the last one came.
--
-- Expand only: a new table nothing reads or writes. CREATE TABLE ... (LIKE)
-- takes ACCESS SHARE on delivery_event, which no writer waits for. The
-- partition bounds are the smallest uuid v7 of each month's first
-- millisecond (UTC), as text under the column's collation, which is how the
-- queries compare ids and so how they prune.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "delivery_event_part" (
    LIKE "delivery_event" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE ("id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"delivery_event_part"'::regclass
      AND conname = 'delivery_event_part_pkey'
  ) THEN
    ALTER TABLE "delivery_event_part"
      ADD CONSTRAINT "delivery_event_part_pkey" PRIMARY KEY ("id");
  END IF;
END $$;

-- The legacy partition and the months ahead.
DO $$
DECLARE
  first_month CONSTANT timestamp := date_trunc('month', timezone('UTC', now()));
  month_start timestamp;
  hex_from text;
  hex_to text;
BEGIN
  hex_to := lpad(to_hex((extract(epoch FROM first_month) * 1000)::bigint), 12, '0');

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "delivery_event_part"
       FOR VALUES FROM (MINVALUE) TO (%L)',
    'delivery_event_part_legacy',
    substr(hex_to, 1, 8) || '-' || substr(hex_to, 9, 4) || '-0000-0000-000000000000'
  );

  FOR step IN 0..3 LOOP
    month_start := first_month + make_interval(months => step);
    hex_from := lpad(to_hex((extract(epoch FROM month_start) * 1000)::bigint), 12, '0');
    hex_to := lpad(to_hex((extract(epoch FROM month_start + interval '1 month') * 1000)::bigint), 12, '0');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "delivery_event_part"
         FOR VALUES FROM (%L) TO (%L)',
      'delivery_event_part_' || to_char(month_start, 'YYYYMM'),
      substr(hex_from, 1, 8) || '-' || substr(hex_from, 9, 4) || '-0000-0000-000000000000',
      substr(hex_to, 1, 8) || '-' || substr(hex_to, 9, 4) || '-0000-0000-000000000000'
    );
  END LOOP;
END $$;

-- The indexes of delivery_event, on the parent (each partition gets its own).
CREATE INDEX IF NOT EXISTS "delivery_event_part_client_submission_id_idx" ON "delivery_event_part"("client_submission_id");
CREATE INDEX IF NOT EXISTS "delivery_event_part_deliveryId_created_at_idx" ON "delivery_event_part"("deliveryId", "created_at");
CREATE INDEX IF NOT EXISTS "delivery_event_part_businessId_created_at_idx" ON "delivery_event_part"("businessId", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "delivery_event_part_businessId_id_idx" ON "delivery_event_part"("businessId", "id");
CREATE INDEX IF NOT EXISTS "delivery_event_part_routeId_idx" ON "delivery_event_part"("routeId");
CREATE INDEX IF NOT EXISTS "delivery_event_part_reportedById_idx" ON "delivery_event_part"("reportedById");
CREATE INDEX IF NOT EXISTS "delivery_event_part_reasonId_partial_idx" ON "delivery_event_part"("reasonId") WHERE "reasonId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "delivery_event_part_occurrenceId_partial_idx" ON "delivery_event_part"("occurrenceId") WHERE "occurrenceId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "delivery_event_part_apiKeyId_partial_idx" ON "delivery_event_part"("apiKeyId") WHERE "apiKeyId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "delivery_event_part_feed_idx" ON "delivery_event_part"("businessId", (COALESCE("txid", 0)), "id");

ALTER TABLE "delivery_event_part" ALTER COLUMN "businessId" SET STATISTICS 1000;
