import { Prisma } from "@prisma/client";

import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { queueLegacyBound } from "@/shared/database/queue-legacy-bound";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";
import { throwIfPartial } from "@/shared/errors/partial-run-error";

import { deleteInBatches, purgeDeadline } from "./batch-delete";

const log = logger.child({
  component: "cron",
  job: "cleanup-webhook-deliveries",
});

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * How long a settled webhook row is kept: WEBHOOK_DELIVERY_RETENTION_DAYS,
 * the replay window plus one day by default and never less (the env
 * refuses it).
 *
 * The window is what the contract promises (a resend of anything younger is
 * accepted) and it is measured from the row's own created_at, like the
 * refusal in the resend route. The extra day is grace, so a row a person
 * sees in the monitor as resendable is never deleted between the listing and
 * the click. A resend is a NEW row with its own created_at, so the copy
 * always outlives the original and neither is removed early.
 *
 * Once the swap of F5-09 made webhook_delivery partitioned by day, a day
 * past the retention leaves whole in the partition-maintenance job
 * (F5-12, the webhook-deliveries gate), and the batches below only reach
 * the legacy partition (every id under queueLegacyBound): a DELETE in the
 * days the DROP takes would be the dead rows and the WAL the partitions
 * exist to avoid.
 */

/**
 * Ceiling on rows removed per run.
 *
 * Sized for the largest profile: a few hundred thousand webhook rows a day
 * across all tenants. Two million lets one night absorb several days of
 * backlog — the first run after this job ships, or a run missed during an
 * outage — while each batch stays a sub-second statement.
 */
const MAX_DELIVERIES_PER_RUN = 2_000_000;

/**
 * The rows the purge may take: settled, and created before the cutoff.
 *
 * The statuses are SQL literals on purpose: that is what lets the planner
 * prove the partial index webhook_delivery_purge_idx ("created_at") WHERE
 * status IN ('DELIVERED','FAILED'). A bound parameter cannot, in a generic
 * plan. Exported so the plan can be tested with the exact predicate.
 */
function settledWebhookDeliveriesBefore(
  cutoff: Date,
  idBelow: string | null = null,
): Prisma.Sql {
  return Prisma.sql`"status" IN ('DELIVERED', 'FAILED') AND "created_at" < ${cutoff}${
    idBelow === null ? Prisma.empty : Prisma.sql` AND "id" < ${idBelow}`
  }`;
}

/**
 * Purges settled webhook deliveries once they leave the replay window.
 *
 * The ledger used to grow forever: every event of every subscribed endpoint
 * kept its payload twice (JSONB and the signed bytes) plus up to a kilobyte
 * of the receiver's answer, and the monitor's counters and the backup grew
 * with it. Only DELIVERED and FAILED rows are touched. A PENDING or
 * PROCESSING row belongs to the dispatcher whatever its age — a parked row
 * waiting for its endpoint is closed as FAILED by the dispatcher when the
 * window runs out, and is purged on a later night.
 *
 * Ordered by created_at over the partial index webhook_delivery_purge_idx
 * (see settledWebhookDeliveriesBefore): the ORDER BY is free and every batch
 * walks from the oldest settled row and stops at the cutoff, instead of
 * scanning the rows still in flight.
 *
 * Cron: "20 4 * * *" → daily at 04:20, after the user-history purge (04:00)
 * and the position partitions (04:10), before the orphan-upload sweep (04:50).
 */
const cleanupWebhookDeliveriesJob: CronJobDefinition = {
  name: "cleanup-webhook-deliveries",
  schedule: "20 4 * * *",

  async handler() {
    const deadline = purgeDeadline();

    const cutoff = new Date(
      Date.now() - env.WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS,
    );

    // Null while the ledger is a plain table: every row, as always.
    const idBelow = await queueLegacyBound(databaseBatch, ["webhook_delivery"]);

    const result = await deleteInBatches({
      table: Prisma.sql`"webhook_delivery"`,
      where: settledWebhookDeliveriesBefore(cutoff, idBelow),
      orderBy: Prisma.sql`"created_at"`,
      maxRows: MAX_DELIVERIES_PER_RUN,
      deadline,
    });

    log.info(
      {
        deleted: result.deleted,
        retentionDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
      },
      "settled webhook deliveries purged",
    );

    // Rows still due: FAILED "[partial]", for the catch-up's partial window.
    throwIfPartial({ webhook_delivery: result });
  },
};

export { cleanupWebhookDeliveriesJob, settledWebhookDeliveriesBefore };
