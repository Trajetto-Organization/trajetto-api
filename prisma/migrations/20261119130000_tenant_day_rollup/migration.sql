-- ----------------------------------------------------------------------------
-- The dashboard's closed days and the marks of the days that changed
-- (plano-escala F4-20, decision D52)
-- ----------------------------------------------------------------------------
-- The overview and the trends count months of deliveries on every view
-- (dashboard-repository.ts, by created_at): at 5M deliveries a month that is
-- the most expensive read of the panel. F4-21 counts each closed day once,
-- into tenant_day_count, and F4-22 adds those days to today's live count.
--
-- A closed day changes only when one of its rows does: a delivery deleted
-- (an import reversal, the purge of a company) or, for a count by status,
-- its status changed. tenant_day_dirty holds those days, written by the
-- triggers of the next migration (20261119130100), so the job counts them
-- again within one run, 15 min, whatever their age.
--
-- tenant_day_dirty has no foreign key and no unique key on purpose
-- (schema.prisma, TenantDayDirty, says why): its rows are written inside
-- the DELETE of the company's deliveries, where a key to the company would
-- fail the DELETE, and a unique key would make concurrent writers of
-- deliveries wait for each other. The purge deletes both tables
-- (purge-plan.ts), the dirty days after the deliveries.
--
-- Expand only: two new tables nothing reads or writes before the next
-- migration's triggers. The foreign key of tenant_day_count takes SHARE
-- ROW EXCLUSIVE on "business" until this migration commits, so it goes
-- last, with the same attempts as 20261118140100_activity_part_business_fk
-- (that migration says why one second longer than deadlock_timeout). A
-- rollback leaves the tables empty and unused.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "tenant_day_count" (
    "businessId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "value" BIGINT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_day_count_pkey" PRIMARY KEY ("businessId","metric","day")
);

-- CreateTable
CREATE TABLE "tenant_day_dirty" (
    "id" BIGSERIAL NOT NULL,
    "businessId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "marked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_day_dirty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenant_day_dirty_businessId_day_idx" ON "tenant_day_dirty"("businessId", "day");

-- AddForeignKey
DO $$
DECLARE
  attempt integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"tenant_day_count"'::regclass
      AND conname = 'tenant_day_count_businessId_fkey'
  ) THEN
    RETURN;
  END IF;

  PERFORM set_config(
    'lock_timeout',
    (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms',
    true
  );

  LOOP
    BEGIN
      ALTER TABLE "tenant_day_count"
        ADD CONSTRAINT "tenant_day_count_businessId_fkey"
        FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;

      IF attempt >= 30 THEN
        RAISE;
      END IF;

      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
