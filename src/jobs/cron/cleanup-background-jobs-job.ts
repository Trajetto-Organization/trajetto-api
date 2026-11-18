import { Prisma } from "@prisma/client";

import { env } from "@/env";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";
import { throwIfPartial } from "@/shared/errors/partial-run-error";
import {
  importObjectsKept,
  releaseImportObjects,
} from "@/modules/import/services/import-object-release";

import { deleteInBatches, purgeDeadline } from "./batch-delete";

const log = logger.child({ component: "cron", job: "cleanup-background-jobs" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A night of finished jobs is a few hundred rows (uploads, undos, a purge
 * or an anonymization now and then); this leaves room for a backlog of
 * months after an outage, each batch a sub-second statement.
 */
const MAX_JOBS_PER_RUN = 100_000;

/**
 * The finished jobs past their retention (plano-escala F3-22). The
 * statuses are literals, so the planner reads background_job's (status,
 * finished_at) index; a PENDING or PROCESSING job belongs to the runner
 * whatever its age. Exported so the predicate can be tested as it runs.
 */
function finishedJobsBefore(
  succeededBefore: Date,
  failedBefore: Date,
): Prisma.Sql {
  // A durable import whose stored file is still there is kept until the
  // release below deletes the file (F3-23a).
  return Prisma.sql`(("status" = 'SUCCEEDED' AND "finished_at" < ${succeededBefore}) OR ("status" IN ('FAILED', 'CANCELLED') AND "finished_at" < ${failedBefore})) AND NOT ${importObjectsKept}`;
}

/**
 * Purges the durable jobs once they leave their retention: a SUCCEEDED job
 * after BACKGROUND_JOB_SUCCEEDED_RETENTION_DAYS (30), a FAILED or
 * CANCELLED one after BACKGROUND_JOB_FAILED_RETENTION_DAYS (90), the
 * failure kept longer because it is what somebody comes back to read.
 * The job's domain record (the upload, the company) keeps its own trail.
 * Before the purge, the stored files of the durable imports are released:
 * an hour after a success, seven days after a failure.
 *
 * On the maintenance pool, in bounded batches (batch-delete.ts).
 *
 * Cron: "52 3 * * *" → daily at 03:52, between the AI purge and the user
 * history's (docs/operacao/jobs.md).
 */
const cleanupBackgroundJobsJob: CronJobDefinition = {
  name: "cleanup-background-jobs",
  schedule: "52 3 * * *",

  async handler() {
    const deadline = purgeDeadline();
    const now = Date.now();

    // The stored files of the durable imports first (F3-23a): a day the
    // storage does not answer leaves them, and their jobs, for tomorrow.
    await releaseImportObjects({ now });

    const jobs = await deleteInBatches({
      table: Prisma.sql`"background_job"`,
      where: finishedJobsBefore(
        new Date(now - env.BACKGROUND_JOB_SUCCEEDED_RETENTION_DAYS * DAY_MS),
        new Date(now - env.BACKGROUND_JOB_FAILED_RETENTION_DAYS * DAY_MS),
      ),
      maxRows: MAX_JOBS_PER_RUN,
      deadline,
    });

    log.info({ deleted: jobs.deleted }, "finished background jobs purged");

    throwIfPartial({ background_job: jobs });
  },
};

export { cleanupBackgroundJobsJob, finishedJobsBefore };
