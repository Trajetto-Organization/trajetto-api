-- ----------------------------------------------------------------------------
-- ops_sample: one row per process per minute (plano-escala F1, item F1-08)
-- ----------------------------------------------------------------------------
-- The scale plan's series: every process writes its runtime numbers once a
-- minute from a local timer with jitter (src/shared/health/ops-sample.ts),
-- so the ADR 0001 triggers are read from 14 days of measurements. Infra
-- numbers only: no businessId, no IP, nobody's id.
--
-- Expand only: a new table the serving release never reads, so a rollback
-- leaves it unused. About 1,440 rows per process per day; the retention of
-- the series purges it in batches.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "ops_sample" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "role" TEXT NOT NULL,
    "replica" TEXT NOT NULL,
    "commit" TEXT,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "ops_sample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_sample_ts_idx" ON "ops_sample"("ts");
