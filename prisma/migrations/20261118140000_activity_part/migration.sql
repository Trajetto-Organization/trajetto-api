-- ----------------------------------------------------------------------------
-- activity_part: the partitioned shell of the activity trail
-- (plano-escala F2-18)
-- ----------------------------------------------------------------------------
-- activity is written by every action of every user and kept for good
-- (ACTIVITY_RETENTION_DAYS is opt-in and at least a year): at the 5M scale
-- some millions of rows a month, read by company and period. It moves to a
-- table partitioned by month on its id at the copy window of wave 11
-- (prisma/post-deploy/31-activity-window.sql, approved by
-- HISTORY_WINDOW_APPROVED): an INSERT ... SELECT into this shell, where the
-- ids of before the v7 switch (random uuid v4) are re-keyed to a v7 of
-- their created_at, then a rename of each table. This file only makes the
-- shell, empty, so the window has nothing left to build under its lock:
--
-- - the same columns, defaults and NOT NULLs as activity, by LIKE (a
--   column added to activity before the window must be added here too:
--   tests/E2E/history-window-activity.test.ts compares them);
-- - the primary key on id, the partition key;
-- - a legacy partition FROM (MINVALUE) up to the first id of this month,
--   where the copy puts the history, and one partition a month from this
--   one to three ahead; the nightly partition-maintenance job keeps three
--   months made from then on (src/shared/database/partitions.ts), and the
--   release step makes trajetto_partitions their owner
--   (infra/sql/10-partitions.sql);
-- - every index of activity, named *_part_* (the window renames them to
--   the canonical names). One difference, on purpose: deliveryId is a
--   plain index here. A partitioned table cannot hold a unique index
--   without its partition key, and an activity of the notification
--   pipeline is already written under its delivery's id (F2-15), which
--   the primary key keeps unique;
-- - the businessId statistics target of activity (F2-22).
--
-- The two foreign keys come one per migration, right after this one: each
-- takes SHARE ROW EXCLUSIVE on the table it references (business, user).
--
-- Expand only: a new table nothing reads or writes. CREATE TABLE ... (LIKE)
-- takes ACCESS SHARE on activity, which no writer waits for. The partition
-- bounds are the smallest uuid v7 of each month's first millisecond (UTC),
-- as text under the column's collation, which is how the queries compare
-- ids and so how they prune.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "activity_part" (
    LIKE "activity" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE ("id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"activity_part"'::regclass
      AND conname = 'activity_part_pkey'
  ) THEN
    ALTER TABLE "activity_part"
      ADD CONSTRAINT "activity_part_pkey" PRIMARY KEY ("id");
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
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "activity_part"
       FOR VALUES FROM (MINVALUE) TO (%L)',
    'activity_part_legacy',
    substr(hex_to, 1, 8) || '-' || substr(hex_to, 9, 4) || '-0000-0000-000000000000'
  );

  FOR step IN 0..3 LOOP
    month_start := first_month + make_interval(months => step);
    hex_from := lpad(to_hex((extract(epoch FROM month_start) * 1000)::bigint), 12, '0');
    hex_to := lpad(to_hex((extract(epoch FROM month_start + interval '1 month') * 1000)::bigint), 12, '0');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "activity_part"
         FOR VALUES FROM (%L) TO (%L)',
      'activity_part_' || to_char(month_start, 'YYYYMM'),
      substr(hex_from, 1, 8) || '-' || substr(hex_from, 9, 4) || '-0000-0000-000000000000',
      substr(hex_to, 1, 8) || '-' || substr(hex_to, 9, 4) || '-0000-0000-000000000000'
    );
  END LOOP;
END $$;

-- The indexes of activity, on the parent (each partition gets its own).
CREATE INDEX IF NOT EXISTS "activity_part_deliveryId_idx" ON "activity_part"("deliveryId");
CREATE INDEX IF NOT EXISTS "activity_part_businessId_created_at_idx" ON "activity_part"("businessId", "created_at");
CREATE INDEX IF NOT EXISTS "activity_part_performedBy_created_at_idx" ON "activity_part"("performedBy", "created_at");
CREATE INDEX IF NOT EXISTS "activity_part_businessId_performedBy_visibilityLevel_idx" ON "activity_part"("businessId", "performedBy", "visibilityLevel");
CREATE INDEX IF NOT EXISTS "activity_part_created_at_idx" ON "activity_part"("created_at");

ALTER TABLE "activity_part" ALTER COLUMN "businessId" SET STATISTICS 1000;
