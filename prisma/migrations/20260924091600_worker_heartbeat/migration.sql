-- Whether each worker of each replica is alive, and when each cron job last
-- succeeded.
--
-- The workers guard their cycles with in-memory flags released only in a
-- finally block: a cycle stuck on an await that never returns silently stops
-- that replica's worker, and /health/liveness answers 200 regardless. Each
-- replica now flushes its in-memory heartbeats (last progress, start of the
-- current cycle) to worker_heartbeat, one row per (replica, worker), so the
-- metrics and the alerting see every replica and not only the one that
-- answered. updated_at has a database default because the flush is a single
-- raw INSERT ... ON CONFLICT DO UPDATE, which sets it on the update side.
--
-- scheduled_job_execution (status, jobName, finishedAt): "when did each job
-- last succeed?" for /health/metrics, and "which runs were left RUNNING by a
-- replica that died?" for the sweep that closes them before each firing.
-- Both tables are small; plain builds.

CREATE TABLE "worker_heartbeat" (
    "replica" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL,
    "runningSince" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_heartbeat_pkey" PRIMARY KEY ("replica","worker")
);

CREATE INDEX IF NOT EXISTS "scheduled_job_execution_status_jobName_finishedAt_idx"
  ON "scheduled_job_execution"("status", "jobName", "finishedAt");
