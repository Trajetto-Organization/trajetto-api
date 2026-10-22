import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import {
  DELETE_BATCH_SIZE,
  deleteInBatches,
  PURGE_RUN_BUDGET_MS,
} from "./batch-delete";
import { OPS_HEARTBEAT_JOB } from "./ops-heartbeat-job";

const log = logger.child({
  component: "cron",
  job: "cleanup-notification-pipeline",
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Published events have served their purpose; a month covers any audit look. */
const PUBLISHED_RETENTION_DAYS = 30;

/**
 * Failures stay longer — they are the ones someone may still investigate.
 *
 * Both kinds: an event that failed to fan out (kept in domain_outbox_event),
 * and a delivery that failed to send. The latter belongs to a PUBLISHED event,
 * whose purge at 30 days cascades to it, so it is copied to
 * notification_dead_letter by the same statement that deletes the event
 * (publishedPurgeBatchSql) and kept there for these 90 days, counted from the
 * failure.
 */
const FAILED_RETENTION_DAYS = 90;

const JOB_EXECUTION_RETENTION_DAYS = 30;

/**
 * The ops heartbeat fires every minute (1,440 rows a day). Its rows only
 * elect the replica that pings; two days is plenty to look at, and keeps the
 * table the cron metrics read at its old size.
 */
const HEARTBEAT_EXECUTION_RETENTION_DAYS = 2;

/**
 * Ceiling on published events removed per run.
 *
 * The floor is the daily inflow, and at the target scale (ADR 0001: 5M
 * deliveries a month, 1 to 1.7M events a day) the old 1M ceiling — sized for
 * a "~400k events/day" figure that was off by a factor of three to four — sat
 * BELOW the inflow: the table would have grown every night. 5M is about three
 * days of inflow, so a skipped night is caught up by the next run. In
 * practice the run's deadline (PURGE_RUN_BUDGET_MS) is the bound that bites
 * first; a run stopped by either one says so in the log.
 */
const MAX_PUBLISHED_PER_RUN = 5_000_000;

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
 * Provider receipts no delivery claims (deliveryId NULL: a callback for a
 * message sent before the delivery id travelled with it, or for a row
 * already purged). The cascade that takes the tied ones never reaches them,
 * so they get the same 30 days here. The ceiling is belt and braces: they are
 * a small fraction of the callbacks.
 */
const UNTIED_RECEIPT_RETENTION_DAYS = 30;
const MAX_UNTIED_RECEIPTS_PER_RUN = 100_000;

/**
 * Heartbeats of replicas that stopped writing them (replaced by a deploy,
 * scaled down). A live replica rewrites its rows every 30 seconds, so a day
 * without a write is a replica that is gone. A handful of rows per replica.
 */
const HEARTBEAT_RETENTION_DAYS = 1;

interface PurgeResult {
  deleted: number;
  archived: number;

  /** True when the cap or the deadline stopped it with due events left. */
  stoppedEarly: boolean;
}

/**
 * One batch of the PUBLISHED purge, with the dead-letter archive inside it
 * (OUTBOX-18).
 *
 * Deliveries belong to their event and go with it by cascade, 30 days after
 * the event was processed — the failed ones and their providerMessageId
 * included, which is what support needs five weeks later. So the batch
 * copies the FAILED deliveries of the events it is about to delete into
 * notification_dead_letter, with everything needed to answer "what failed,
 * for whom and why" without the event, the delivery or the recipient.
 *
 * One statement, so the copy and the delete commit together: data-modifying
 * CTEs share one snapshot, and the cascade runs as an end-of-statement
 * trigger, after the INSERT has read the deliveries. The archive used to be a
 * separate walk before the purge, and its last statement read EVERY retained
 * failure (to find the few whose event was due) — past the 30 s
 * statement_timeout at the target scale, which stopped the purge every night.
 * Now the cost follows what is purged: the due events come from the partial
 * index on processedAt, and their deliveries from the outboxEventId index.
 * Idempotent: the archive's key is the delivery id (ON CONFLICT DO NOTHING).
 */
function publishedPurgeBatchSql(
  publishedBefore: Date,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    WITH batch AS (
      SELECT "id", "topic", "businessId"
      FROM "domain_outbox_event"
      WHERE "status" = 'PUBLISHED' AND "processedAt" < ${publishedBefore}
      ORDER BY "processedAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    archived AS (
      INSERT INTO "notification_dead_letter" (
        "id", "outboxEventId", "topic", "businessId",
        "userId", "externalRecipientId", "channel", "attempts",
        "lastError", "providerMessageId", "created_at", "failedAt"
      )
      SELECT
        d."id", d."outboxEventId", b."topic", b."businessId",
        d."userId", d."externalRecipientId", d."channel", d."attempts",
        d."lastError", d."providerMessageId", d."created_at", d."updated_at"
      FROM batch b
      -- Per event, through the outboxEventId index. OFFSET 0 keeps the
      -- planner from flattening this into a join that hashes every retained
      -- failure (notification_delivery_failed_idx) to match a few events.
      CROSS JOIN LATERAL (
        SELECT *
        FROM "notification_delivery" f
        WHERE f."outboxEventId" = b."id" AND f."status" = 'FAILED'
        OFFSET 0
      ) d
      ON CONFLICT ("id") DO NOTHING
      RETURNING 1
    ),
    removed AS (
      DELETE FROM "domain_outbox_event" e
      USING batch b
      WHERE e."id" = b."id"
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM removed)::int AS deleted,
      (SELECT count(*) FROM archived)::int AS archived
  `;
}

/**
 * Deletes due PUBLISHED events in batches, archiving their failed deliveries
 * on the way, until none is left, the cap is reached or the deadline passes.
 * Each batch is its own statement, so no transaction outlives a batch.
 */
async function purgePublishedEvents(
  publishedBefore: Date,
  deadline: number,
): Promise<PurgeResult> {
  let deleted = 0;
  let archived = 0;

  while (deleted < MAX_PUBLISHED_PER_RUN) {
    if (Date.now() >= deadline) {
      return { deleted, archived, stoppedEarly: true };
    }

    const limit = Math.min(DELETE_BATCH_SIZE, MAX_PUBLISHED_PER_RUN - deleted);

    const [batch] = await database.$queryRaw<
      Array<{ deleted: number; archived: number }>
    >(publishedPurgeBatchSql(publishedBefore, limit));

    deleted += batch.deleted;
    archived += batch.archived;

    // A short batch: nothing due is left, or the rest is locked by a
    // concurrent run that is deleting it.
    if (batch.deleted < limit) {
      return { deleted, archived, stoppedEarly: false };
    }
  }

  return { deleted, archived, stoppedEarly: true };
}

/**
 * Prunes the notification pipeline's operational tables.
 *
 * These tables are work queues, not archives: every event and delivery row
 * exists to be processed once and consulted rarely. Without pruning, the
 * `FOR UPDATE SKIP LOCKED` claims scan an ever-growing table for the same
 * handful of pending rows. Deliveries go with their event via cascade — the
 * FAILED ones copied to notification_dead_letter in the same statement, where
 * they stay 90 days (publishedPurgeBatchSql).
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

    // Each batch copies the failed deliveries of the events it deletes, in
    // the same statement: the cascade from a purged event takes its
    // deliveries (publishedPurgeBatchSql).
    const published = await purgePublishedEvents(publishedBefore, deadline);

    // The archive's own retention, counted from the failure. failedAt is
    // indexed, so the scan starts at the oldest rows and stops at the batch.
    const archiveExpired = await deleteInBatches({
      table: Prisma.sql`"notification_dead_letter"`,
      where: Prisma.sql`"failedAt" < ${failedBefore}`,
      orderBy: Prisma.sql`"failedAt"`,
      maxRows: MAX_FAILED_PER_RUN,
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

    // A range of the (jobName, scheduledFor) unique index.
    const heartbeatExecutions = await deleteInBatches({
      table: Prisma.sql`"scheduled_job_execution"`,
      where: Prisma.sql`"jobName" = ${OPS_HEARTBEAT_JOB} AND "scheduledFor" < ${new Date(
        Date.now() - HEARTBEAT_EXECUTION_RETENTION_DAYS * DAY_MS,
      )}`,
      maxRows: MAX_JOB_EXECUTIONS_PER_RUN,
      deadline,
    });

    const untiedReceipts = await deleteInBatches({
      table: Prisma.sql`"notification_provider_receipt"`,
      where: Prisma.sql`"deliveryId" IS NULL AND "created_at" < ${new Date(
        Date.now() - UNTIED_RECEIPT_RETENTION_DAYS * DAY_MS,
      )}`,
      maxRows: MAX_UNTIED_RECEIPTS_PER_RUN,
      deadline,
    });

    const goneReplicas = await database.workerHeartbeat.deleteMany({
      where: {
        updated_at: {
          lt: new Date(Date.now() - HEARTBEAT_RETENTION_DAYS * DAY_MS),
        },
      },
    });

    if (goneReplicas.count > 0) {
      log.info(
        { workerHeartbeats: goneReplicas.count },
        "heartbeats of gone replicas purged",
      );
    }

    if (untiedReceipts.deleted > 0) {
      log.info(
        { untiedProviderReceipts: untiedReceipts.deleted },
        "untied provider receipts purged",
      );
    }

    log.info(
      {
        publishedEvents: published.deleted,
        failedEvents: failed.deleted,
        cronExecutions: executions.deleted + heartbeatExecutions.deleted,
        archivedDeadLetters: published.archived,
        expiredDeadLetters: archiveExpired.deleted,
      },
      "notification pipeline purged",
    );

    if (published.stoppedEarly || failed.stoppedEarly) {
      log.warn(
        "notification pipeline purge stopped at the run's cap or deadline; the rest waits for the next window",
      );
    }
  },
};

export { cleanupNotificationPipelineJob, publishedPurgeBatchSql };
