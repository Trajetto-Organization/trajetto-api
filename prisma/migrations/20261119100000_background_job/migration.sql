-- ----------------------------------------------------------------------------
-- background_job: the durable jobs of the `jobs` queue (plano-escala F3-22)
-- ----------------------------------------------------------------------------
-- The long work lived in the memory of the replica that answered the
-- request: a spreadsheet of 20 thousand rows (import-queue.ts), a large
-- undo, and, from this wave on, a company's purge and a person's
-- anonymization. A deploy, an OOM or a SIGKILL dropped it halfway, and
-- the abandoned-import sweep could only close what was left. A job is now
-- a row here, claimed by the processes that consume the `jobs` queue
-- (WORKER_QUEUES; every process in the role `all`, today's production)
-- with the fair claim of the other queues (company by company, SKIP
-- LOCKED), a lease of 120 s renewed every 40 s, and a progress cursor
-- written under a fence on `attempts`: a process that lost its lease can
-- no longer write, and the one that took over resumes from the cursor
-- (src/shared/jobs/job-runner.ts).
--
--  - background_job_fair_idx: the fair claim's walk, (company, due time),
--    over the rows that can still be claimed;
--  - background_job_due_idx: the oldest due rows (the claim's fill, the
--    job-overdue alert);
--  - background_job_live_subject_key: one live job per kind and subject
--    (the upload, the user, the company), so a double click or a retry
--    of the request never enqueues the same work twice;
--  - (status, finished_at): the retention purge of the finished rows
--    (BACKGROUND_JOB_SUCCEEDED_RETENTION_DAYS and _FAILED_).
--
-- No foreign key to business on purpose: the purge of a company
-- (TENANT_OFFBOARD) is itself a row here and outlives the company it
-- deletes; the jobs filter by "businessId" like every other queue.
--
-- Expand only: a new table and two new types the serving release never
-- reads, so a rollback leaves them unused.
-- ----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "BackgroundJobKind" AS ENUM ('SPREADSHEET_IMPORT', 'IMPORT_REVERSAL', 'TENANT_OFFBOARD', 'USER_ANONYMIZE', 'PARTITION_ARCHIVE', 'ROLLUP_BACKFILL');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "kind" "BackgroundJobKind" NOT NULL,
    "businessId" TEXT,
    "subjectId" TEXT,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "leaseExpiresAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "progress" JSONB,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "background_job_status_finished_at_idx" ON "background_job"("status", "finished_at");

-- Partial indexes (Prisma cannot declare them; see the model's comment).
CREATE INDEX "background_job_fair_idx" ON "background_job" ("businessId", "availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "background_job_due_idx" ON "background_job" ("availableAt") WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE UNIQUE INDEX "background_job_live_subject_key" ON "background_job" ("kind", "subjectId") WHERE "status" IN ('PENDING', 'PROCESSING') AND "subjectId" IS NOT NULL;
