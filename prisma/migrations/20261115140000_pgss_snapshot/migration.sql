-- ----------------------------------------------------------------------------
-- pgss_snapshot: the hourly cost of the top statements (plano-escala F1-12)
-- ----------------------------------------------------------------------------
-- pg_stat_statements is cumulative: one reading says nothing about the last
-- hour. The hourly job (src/jobs/cron/snapshot-query-stats-job.ts) keeps
-- every statement's counters in pgss_baseline and, an hour later, writes the
-- difference of the 200 most expensive ones to pgss_snapshot; pgss_state
-- keeps what it last saw of the extension itself (stats_reset, dealloc), so
-- a reset or an eviction is never subtracted into a negative number
-- (src/shared/health/pgss-diff.ts).
--
-- The query texts may carry literals (a CPF, an e-mail in a statement that
-- was not normalized): they stay in this table, read with psql, and no route
-- serves them.
--
-- Expand only: three new tables the serving release never reads, so a
-- rollback leaves them unused. About 200 rows an hour; the retention of the
-- series purges pgss_snapshot after 30 days, in batches (F1-13).
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "pgss_snapshot" (
    "id" TEXT NOT NULL,
    "taken_at" TIMESTAMP(3) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "basis" TEXT NOT NULL,
    "userid" BIGINT NOT NULL,
    "toplevel" BOOLEAN NOT NULL,
    "queryid" BIGINT NOT NULL,
    "query" TEXT,
    "calls" BIGINT NOT NULL,
    "total_exec_time_ms" DOUBLE PRECISION NOT NULL,
    "total_plan_time_ms" DOUBLE PRECISION NOT NULL,
    "max_exec_time_ms" DOUBLE PRECISION NOT NULL,
    "rows" BIGINT NOT NULL,
    "shared_blks_hit" BIGINT NOT NULL,
    "shared_blks_read" BIGINT NOT NULL,
    "shared_blks_dirtied" BIGINT NOT NULL,
    "shared_blks_written" BIGINT NOT NULL,
    "temp_blks_written" BIGINT NOT NULL,
    "wal_bytes" BIGINT NOT NULL,

    CONSTRAINT "pgss_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pgss_baseline" (
    "userid" BIGINT NOT NULL,
    "toplevel" BOOLEAN NOT NULL,
    "queryid" BIGINT NOT NULL,
    "calls" BIGINT NOT NULL,
    "total_exec_time_ms" DOUBLE PRECISION NOT NULL,
    "total_plan_time_ms" DOUBLE PRECISION NOT NULL,
    "rows" BIGINT NOT NULL,
    "shared_blks_hit" BIGINT NOT NULL,
    "shared_blks_read" BIGINT NOT NULL,
    "shared_blks_dirtied" BIGINT NOT NULL,
    "shared_blks_written" BIGINT NOT NULL,
    "temp_blks_written" BIGINT NOT NULL,
    "wal_bytes" BIGINT NOT NULL,

    CONSTRAINT "pgss_baseline_pkey" PRIMARY KEY ("userid","toplevel","queryid")
);

-- CreateTable
CREATE TABLE "pgss_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "taken_at" TIMESTAMP(3) NOT NULL,
    "stats_reset" TIMESTAMP(3),
    "dealloc" BIGINT NOT NULL,
    "statements" INTEGER NOT NULL,

    CONSTRAINT "pgss_state_pkey" PRIMARY KEY ("id"),
    -- One row: the state of the last snapshot, never a log.
    CONSTRAINT "pgss_state_single_row" CHECK ("id" = 1)
);

-- CreateIndex
CREATE INDEX "pgss_snapshot_taken_at_idx" ON "pgss_snapshot"("taken_at");

-- CreateIndex
CREATE INDEX "pgss_snapshot_queryid_taken_at_idx" ON "pgss_snapshot"("queryid", "taken_at");
