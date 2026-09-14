import { Prisma } from "@prisma/client";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

import { deleteInBatches, PURGE_RUN_BUDGET_MS } from "./batch-delete";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Published events have served their purpose; a month covers any audit look. */
const PUBLISHED_RETENTION_DAYS = 30;

/** Failures stay longer — they are the ones someone may still investigate. */
const FAILED_RETENTION_DAYS = 90;

const JOB_EXECUTION_RETENTION_DAYS = 30;

/**
 * Ceiling on published events removed per run.
 *
 * The floor is the daily inflow: at the ~400k events/day target a nightly
 * purge that removes less than that lets the table grow forever. 1M is 2.5x
 * the inflow, so one skipped night (deploy, outage, lost leader election) is
 * caught up by the next run instead of compounding — while still bounding a
 * single run if a retention constant is ever mistyped.
 */
const MAX_PUBLISHED_PER_RUN = 1_000_000;

/**
 * Failures are a small fraction of the traffic; a run that wants to delete
 * more than 100k of them is a symptom, not a purge, and the ceiling makes it
 * visible in the log instead of burying it in an hour-long delete.
 */
const MAX_FAILED_PER_RUN = 100_000;

/**
 * Bounded by (number of cron jobs x firings per day) across all replicas —
 * a few hundred rows a day. The ceiling is pure belt and braces.
 */
const MAX_JOB_EXECUTIONS_PER_RUN = 100_000;

/**
 * Prunes the notification pipeline's operational tables.
 *
 * These tables are work queues, not archives: every event and delivery row
 * exists to be processed once and consulted rarely. Without pruning, the
 * `FOR UPDATE SKIP LOCKED` claims scan an ever-growing table for the same
 * handful of pending rows. Deliveries go with their event via cascade.
 *
 * Deletes run in bounded batches (see batch-delete.ts) rather than one
 * `deleteMany`: at the target volume a single statement would be a
 * multi-million-row transaction holding the xmin horizon for minutes, which
 * blocks autovacuum across the whole database — the exact failure this job
 * exists to prevent.
 *
 * Only terminal rows are ever matched (PUBLISHED / FAILED), so the job is
 * safe to run while the workers are claiming: it can never race the pipeline
 * for a row.
 *
 * Cron: "30 3 * * *" → daily at 03:30, when nobody is registering fines.
 */
const cleanupNotificationPipelineJob: CronJobDefinition = {
  name: "cleanup-notification-pipeline",
  schedule: "30 3 * * *",

  async handler() {
    const deadline = Date.now() + PURGE_RUN_BUDGET_MS;

    const publishedBefore = new Date(
      Date.now() - PUBLISHED_RETENTION_DAYS * DAY_MS,
    );

    const failedBefore = new Date(Date.now() - FAILED_RETENTION_DAYS * DAY_MS);
    const executionsBefore = new Date(
      Date.now() - JOB_EXECUTION_RETENTION_DAYS * DAY_MS,
    );

    // No ORDER BY on the outbox deletes. Nothing indexes
    // (status, processedAt), so an explicit ordering would force a sort of
    // every matching row before the LIMIT could bite. Without it the LIMIT
    // stops the scan at the batch size, and since rows are inserted in age
    // order the ones past retention sit at the physical start of the heap —
    // measured on a 2M-row table, one 5.000-row batch touches ~190 buffers
    // and commits in ~50ms.
    const published = await deleteInBatches({
      table: Prisma.sql`"domain_outbox_event"`,
      where: Prisma.sql`"status" = 'PUBLISHED' AND "processedAt" < ${publishedBefore}`,
      maxRows: MAX_PUBLISHED_PER_RUN,
      deadline,
    });

    const failed = await deleteInBatches({
      table: Prisma.sql`"domain_outbox_event"`,
      where: Prisma.sql`"status" = 'FAILED' AND "updated_at" < ${failedBefore}`,
      maxRows: MAX_FAILED_PER_RUN,
      deadline,
    });

    const executions = await deleteInBatches({
      table: Prisma.sql`"scheduled_job_execution"`,
      where: Prisma.sql`"created_at" < ${executionsBefore}`,
      maxRows: MAX_JOB_EXECUTIONS_PER_RUN,
      deadline,
    });

    console.log(
      `[CleanupNotificationPipeline] Expurgo: ${published.deleted} evento(s) publicados, ` +
        `${failed.deleted} falho(s), ${executions.deleted} execução(ões) de cron`,
    );

    if (published.stoppedEarly || failed.stoppedEarly) {
      console.warn(
        "[CleanupNotificationPipeline] Expurgo interrompido pelo teto/tempo " +
          "da execução; backlog restante fica para a próxima janela",
      );
    }
  },
};

export { cleanupNotificationPipelineJob };
