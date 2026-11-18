-- ----------------------------------------------------------------------------
-- process_heartbeat: one row per live process (plano-escala F3-03)
-- ----------------------------------------------------------------------------
-- With the roles of wave 12 (PROCESS_ROLE: api, worker, scheduler...), one
-- image runs as several Applications, and nothing in the database said
-- which processes exist, what each one claims and whether they agree on
-- the settings that must not diverge (the JWT keys, the adapter's key, the
-- database and the Redis they point at). Every process now UPSERTs its row
-- every 30 s (± 5) with the database's now(), deletes it on SIGTERM and
-- never stops serving when the write fails (src/shared/health/
-- process-heartbeat.ts). The wake between processes (F3-04) counts the
-- live consumers of a queue here; the deploy's check (F3-31b) and the
-- alerts (F3-34) read the commits, the environments and the fingerprints.
--
-- Expand only: a new table the serving release never reads, so a rollback
-- leaves it unused. A handful of rows, rewritten in place; a row without a
-- beat for 7 days (a process that died without its SIGTERM) is purged by
-- purge-ops-series.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "process_heartbeat" (
    "replica" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "app_env" TEXT NOT NULL,
    "build_commit" TEXT,
    "config_fingerprint" TEXT,
    "node_hostname" TEXT,
    "queues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cron" BOOLEAN NOT NULL,
    "sockets" BOOLEAN NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_heartbeat_pkey" PRIMARY KEY ("replica")
);

-- CreateIndex
CREATE INDEX "process_heartbeat_updated_at_idx" ON "process_heartbeat"("updated_at");
