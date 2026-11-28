-- ----------------------------------------------------------------------------
-- release_step_state: what each step after `migrate deploy` last did
-- (plano-escala F5-08, D19)
-- ----------------------------------------------------------------------------
-- The release step runs, after the migrations, the idempotent SQL of
-- infra/sql (roles, ownership, grants: reapplied on every release, because
-- a pg_restore --no-owner loses them) and prisma/post-deploy (DDL with a
-- precondition). Each file ends saying 'applied', 'skipped' (already done)
-- or 'pending' (it waits for a state: a capability, a lock). The runner
-- (infra/scripts/release-steps.ts) keeps one row per file here, plus the
-- run itself under '@release'. A 'pending' or 'failed' row makes the next
-- deploy run the release step again even when the release image did not
-- change (GET /health/rollout, U-11); a file that left the repository
-- turns 'retired'.
--
-- Expand only: a new table that no running image reads. A handful of rows
-- (one per step file), never purged.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "release_step_state" (
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_step_state_pkey" PRIMARY KEY ("step"),
    CONSTRAINT "release_step_state_status_check" CHECK ("status" IN ('applied', 'skipped', 'pending', 'failed', 'retired'))
);
