import { env } from "@/env";

// The batched delete itself lives with the database code: the user tokens
// repository purges the expired refresh tokens with it too (F1-18).
export {
  anyLeft,
  deleteInBatches,
  DELETE_BATCH_SIZE,
} from "@/shared/database/batch-delete";
export type {
  BatchDeleteParams,
  BatchDeleteResult,
} from "@/shared/database/batch-delete";

/**
 * When one purge run stops, whatever is left: now plus
 * CRON_PURGE_RUN_BUDGET_MS (5 minutes by default, and never more).
 *
 * CronSchedulerService leases an execution for 10 minutes
 * (EXECUTION_LEASE_MS), and its catch-up sweep treats a run past the lease as
 * dead: it marks it FAILED and may run the job again. Stopping at half the
 * lease keeps a slow purge from ever running alongside its own re-run. What
 * is left makes the run partial (PartialRunError): the catch-up sweep takes
 * it again inside the partial window, or the next night does. Read when the
 * run starts, so a test can lower it.
 */
function purgeDeadline(now: number = Date.now()): number {
  return now + env.CRON_PURGE_RUN_BUDGET_MS;
}

export { purgeDeadline };
