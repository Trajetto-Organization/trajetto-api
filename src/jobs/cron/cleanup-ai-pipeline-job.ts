import { Prisma } from "@prisma/client";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { deleteInBatches, PURGE_RUN_BUDGET_MS } from "./batch-delete";

const log = logger.child({ component: "cron", job: "cleanup-ai-pipeline" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Terminal requests are audit trail, so they outlive the notification
 * pipeline's retention — but they are not an archive: the ledger that
 * matters for billing is AIUsagePeriod, which is tiny (one row per business
 * per month) and is never pruned.
 */
const TERMINAL_REQUEST_RETENTION_DAYS = 180;

/**
 * Ceiling on requests removed per run.
 *
 * A request is created once per fuel/checklist submission that goes through
 * AI — an order of magnitude below the outbox event rate, since one
 * submission fans out into several events and many deliveries. A fifth of
 * the outbox ceiling therefore still leaves room to catch up after a missed
 * night. Note that each deleted request drags its units and provider
 * attempts along by cascade, so a batch is a few times its nominal size in
 * actual rows — still a sub-second transaction at 5.000 requests.
 */
const MAX_REQUESTS_PER_RUN = 200_000;

/**
 * Prunes settled AI analysis requests. Units and provider attempts ride
 * along via cascade. Non-terminal rows (PENDING/PROCESSING) are never
 * touched, whatever their age — the pipeline's lease machinery owns those,
 * which is also what makes this job safe to run while the workers claim.
 *
 * Deletes run in bounded batches (see batch-delete.ts) instead of one
 * `deleteMany`, so the purge never becomes a long transaction pinning the
 * xmin horizon and stalling autovacuum database-wide.
 *
 * Cron: "45 3 * * *" → daily at 03:45, after the notification cleanup.
 */
const cleanupAIPipelineJob: CronJobDefinition = {
  name: "cleanup-ai-pipeline",
  schedule: "45 3 * * *",

  async handler() {
    const deadline = Date.now() + PURGE_RUN_BUDGET_MS;

    const terminalBefore = new Date(
      Date.now() - TERMINAL_REQUEST_RETENTION_DAYS * DAY_MS,
    );

    // No ORDER BY, for the same reason as the outbox purge: nothing indexes
    // (status, updated_at), so ordering would sort the whole match set, while
    // the bare LIMIT stops the scan at the batch size over rows that are
    // physically oldest-first anyway.
    const requests = await deleteInBatches({
      table: Prisma.sql`"ai_analysis_request"`,
      where: Prisma.sql`"status" IN ('COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED') AND "updated_at" < ${terminalBefore}`,
      maxRows: MAX_REQUESTS_PER_RUN,
      deadline,
    });

    log.info({ deleted: requests.deleted }, "finished AI analyses purged");

    if (requests.stoppedEarly) {
      log.warn(
        "AI analysis purge stopped at the run's cap or deadline; the rest waits for the next window",
      );
    }
  },
};

export { cleanupAIPipelineJob };
