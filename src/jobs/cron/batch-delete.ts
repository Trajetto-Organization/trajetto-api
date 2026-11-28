import type { Prisma } from "@prisma/client";

import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import {
  anyLeft as anyLeftOn,
  deleteInBatches as deleteInBatchesOn,
  type BatchDeleteParams,
  type BatchDeleteResult,
} from "@/shared/database/batch-delete";

// The batched delete itself lives with the database code: the user tokens
// repository purges the expired refresh tokens with it too (F1-18).
export { DELETE_BATCH_SIZE } from "@/shared/database/batch-delete";
export type {
  BatchDeleteParams,
  BatchDeleteResult,
} from "@/shared/database/batch-delete";

/**
 * The nightly purges run on the maintenance pool (plano-escala F3-18),
 * databaseBatch, not on the pool the requests take connections from: a
 * purge that runs for its whole five-minute budget holds a connection all
 * along, and on the app's pool of ten that is one fewer for every request
 * of the replica. With BATCH_DATABASE_URL unset it is the same server and
 * user, on three connections of its own; after the cut of the database
 * roles it is the trajetto_batch login, the one with DELETE on
 * delivery_event. A caller may still pass its own client.
 */
function deleteInBatches(
  params: BatchDeleteParams,
): Promise<BatchDeleteResult> {
  return deleteInBatchesOn({ client: databaseBatch, ...params });
}

/** Whether any row still matches, on the maintenance pool. */
function anyLeft(table: Prisma.Sql, where: Prisma.Sql): Promise<boolean> {
  return anyLeftOn(table, where, databaseBatch);
}

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

export { anyLeft, deleteInBatches, purgeDeadline };
