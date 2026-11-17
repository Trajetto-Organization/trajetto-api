import { Prisma } from "@prisma/client";

import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { throwIfPartial } from "@/shared/errors/partial-run-error";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";
import { UNTIED_RECEIPT_RETENTION_DAYS } from "@/shared/notifications/receipt-id";

import {
  anyLeft,
  DELETE_BATCH_SIZE,
  deleteInBatches,
  purgeDeadline,
} from "./batch-delete";
import { OPS_HEARTBEAT_JOB } from "./ops-heartbeat-job";

const log = logger.child({
  component: "cron",
  job: "cleanup-notification-pipeline",
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Published events have served their purpose; a month covers any audit
 * look. A FAILED event leaves the queue table at the same age, moved to
 * its dead letter (plano-escala F5-10): the queues become partitioned by
 * day, and a day is dropped whole (F5-11).
 */
const PUBLISHED_RETENTION_DAYS = 30;

/*
 * Failures stay longer — they are the ones someone may still investigate:
 * OUTBOX_FAILED_RETENTION_DAYS (90), counted from the failure, read on
 * every run.
 *
 * Both kinds, each in its dead letter: an event that failed to fan out,
 * moved to outbox_event_dead_letter at 30 days (failedPurgeBatchSql), and
 * a delivery that failed to send. The latter belongs to a PUBLISHED event,
 * whose purge at 30 days takes it with it, so it is copied to
 * notification_dead_letter by the same statement that deletes the event
 * (publishedPurgeBatchSql).
 */

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
 * practice the run's deadline (CRON_PURGE_RUN_BUDGET_MS) is the bound that
 * bites first; a run stopped by either one with events still due is partial.
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
 * already purged). The purge that takes the tied ones never reaches them,
 * so they get the same 30 days here (UNTIED_RECEIPT_RETENTION_DAYS, in
 * receipt-id.ts: the day such a receipt's id starts with is held inside
 * it). The ceiling is belt and braces: they are a small fraction of the
 * callbacks.
 */
const MAX_UNTIED_RECEIPTS_PER_RUN = 100_000;

/**
 * Heartbeats of replicas that stopped writing them (replaced by a deploy,
 * scaled down). A live replica rewrites its rows every 30 seconds, so a day
 * without a write is a replica that is gone. A handful of rows per replica.
 */
const HEARTBEAT_RETENTION_DAYS = 1;

/**
 * Keys of outbox_event_key whose event is gone (plano-escala F5-02): a
 * FAILED event moved to its dead letter at 30 days (F5-10), or an event the
 * previous image purged during a rolling deploy without its key. Only keys
 * older than the failures' retention, so a key keeps saying "already
 * published" as long as the failure is kept anywhere; the PUBLISHED purge
 * takes the keys of its own events with them.
 */
const MAX_ORPHAN_KEYS_PER_RUN = 100_000;

/** The keys of outbox_event_key whose event no longer exists. */
function orphanKeysSql(createdBefore: Date): Prisma.Sql {
  return Prisma.sql`"created_at" < ${createdBefore} AND NOT EXISTS (
    SELECT 1 FROM "domain_outbox_event" e
    WHERE e."id" = "outbox_event_key"."event_id"
  )`;
}

interface PurgeResult {
  deleted: number;
  archived: number;

  /** True when the cap or the deadline stopped it with due events left. */
  stoppedEarly: boolean;
}

/**
 * The deliveries of the events in `batch` and their receipts, deleted in
 * the batch's own statement (plano-escala F5-05): `deliveries` returns
 * their ids and `receipts` deletes by them.
 *
 * The foreign keys of today cascade the same rows when the event goes;
 * wave 10 (F5-06) drops them, and a purge that counted on them would leave
 * every delivery behind. With the keys still there, the cascade at the end
 * of the statement finds nothing left to delete. `= ANY (ARRAY(...))` and
 * not a join: the ids go to the outboxEventId and deliveryId indexes as
 * one array each, where a join let the planner hash the whole index of a
 * table that keeps a month of rows (pinned in
 * tests/E2E/notification-purge-plan.test.ts).
 */
const EVENT_FAMILY_SQL = Prisma.sql`
    deliveries AS (
      DELETE FROM "notification_delivery"
      WHERE "outboxEventId" = ANY (ARRAY(SELECT "id" FROM batch))
      RETURNING "id"
    ),
    receipts AS (
      DELETE FROM "notification_provider_receipt"
      WHERE "deliveryId" = ANY (ARRAY(SELECT "id" FROM deliveries))
    )`;

/**
 * One batch of the PUBLISHED purge, with the dead-letter archive inside it
 * (OUTBOX-18).
 *
 * A delivery belongs to its event and goes with it, 30 days after the
 * event was processed — the failed ones and their providerMessageId
 * included, which is what support needs five weeks later. So the batch
 * copies the FAILED deliveries of the events it is about to delete into
 * notification_dead_letter, with everything needed to answer "what failed,
 * for whom and why" without the event, the delivery or the recipient.
 *
 * One statement, so the copy and the deletes commit together:
 * data-modifying CTEs share one snapshot, so the INSERT reads the
 * deliveries the `deliveries` CTE deletes (EVENT_FAMILY_SQL). The archive
 * used to be a separate walk before the purge, and its last statement read
 * EVERY retained failure (to find the few whose event was due) — past the
 * 30 s statement_timeout at the target scale, which stopped the purge every
 * night. Now the cost follows what is purged: the due events come from the
 * partial index on processedAt, and their deliveries from the outboxEventId
 * index. Idempotent: the archive's key is the delivery id (ON CONFLICT DO
 * NOTHING).
 *
 * The events' keys go in the same statement (plano-escala F5-02): a key row
 * of outbox_event_key outliving its event would say "already published"
 * forever. Through the key's primary key, and only the row that names this
 * event.
 */
function publishedPurgeBatchSql(
  publishedBefore: Date,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    WITH batch AS (
      SELECT "id", "eventKey", "topic", "businessId"
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
    ${EVENT_FAMILY_SQL},
    removed AS (
      DELETE FROM "domain_outbox_event" e
      USING batch b
      WHERE e."id" = b."id"
      RETURNING 1
    ),
    keys AS (
      DELETE FROM "outbox_event_key" k
      USING batch b
      WHERE k."event_key" = b."eventKey" AND k."event_id" = b."id"
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM removed)::int AS deleted,
      (SELECT count(*) FROM archived)::int AS archived
  `;
}

/** What the PUBLISHED purge matches, for the probe before a partial. */
function duePublishedSql(publishedBefore: Date): Prisma.Sql {
  return Prisma.sql`"status" = 'PUBLISHED' AND "processedAt" < ${publishedBefore}`;
}

/** What the FAILED move matches: events that gave up long enough ago. */
function dueFailedSql(failedBefore: Date): Prisma.Sql {
  return Prisma.sql`"status" = 'FAILED' AND "updated_at" < ${failedBefore}`;
}

/**
 * One batch of the FAILED move: the events that gave up before
 * `failedBefore` go to outbox_event_dead_letter and leave the queue table
 * (plano-escala F5-10), in one statement — the copy and the delete share
 * one snapshot and commit together, so an event is always in exactly one
 * of the two places. Idempotent: the copy's key is the event's id (ON
 * CONFLICT DO NOTHING). The copy is kept OUTBOX_FAILED_RETENTION_DAYS from
 * the failure, and replayed as a new event (outbox-dead-letter.ts); an
 * event that failed before `keptFrom` is already past that and is only
 * deleted (a night the purge did not run, or a retention just lowered).
 *
 * An event that failed to expand usually has no delivery; one that a
 * replica expanded after losing its lease, and that then failed under the
 * new owner, does. The cascade took those with the event, so the batch
 * takes them explicitly, with their receipts (EVENT_FAMILY_SQL, F5-05).
 * The keys of these events are left to the orphan-key sweep, as before.
 */
function failedPurgeBatchSql(
  failedBefore: Date,
  keptFrom: Date,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    WITH batch AS (
      SELECT
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "attempts", "lastError",
        "correlationId", "created_at", "updated_at"
      FROM "domain_outbox_event"
      WHERE ${dueFailedSql(failedBefore)}
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    archived AS (
      INSERT INTO "outbox_event_dead_letter" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "attempts", "lastError",
        "correlationId", "created_at", "failedAt"
      )
      SELECT
        b."id", b."eventKey", b."topic", b."aggregateType", b."aggregateId",
        b."businessId", b."actorId", b."payload", b."attempts", b."lastError",
        b."correlationId", b."created_at", b."updated_at"
      FROM batch b
      WHERE b."updated_at" >= ${keptFrom}
      ON CONFLICT ("id") DO NOTHING
      RETURNING 1
    ),
    ${EVENT_FAMILY_SQL},
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
 * Deletes due events in batches of one statement each (`batchSql`), with
 * their family, until none is left, the cap is reached or the deadline
 * passes. Each batch is its own statement, so no transaction outlives a
 * batch. Stopped by the cap or the deadline, it asks whether an event is
 * still due before calling the run partial (as deleteInBatches does).
 */
async function purgeEvents({
  batchSql,
  due,
  maxRows,
  deadline,
}: {
  batchSql: (limit: number) => Prisma.Sql;
  due: Prisma.Sql;
  maxRows: number;
  deadline: number;
}): Promise<PurgeResult> {
  let deleted = 0;
  let archived = 0;

  const table = Prisma.sql`"domain_outbox_event"`;

  while (deleted < maxRows) {
    if (Date.now() >= deadline) {
      return { deleted, archived, stoppedEarly: await anyLeft(table, due) };
    }

    const limit = Math.min(DELETE_BATCH_SIZE, maxRows - deleted);

    const [batch] = await databaseBatch.$queryRaw<
      Array<{ deleted: number; archived: number }>
    >(batchSql(limit));

    deleted += batch.deleted;
    archived += batch.archived;

    // A short batch: nothing due is left, or the rest is locked by a
    // concurrent run that is deleting it.
    if (batch.deleted < limit) {
      return { deleted, archived, stoppedEarly: false };
    }
  }

  return { deleted, archived, stoppedEarly: await anyLeft(table, due) };
}

/**
 * Prunes the notification pipeline's operational tables.
 *
 * These tables are work queues, not archives: every event and delivery row
 * exists to be processed once and consulted rarely. Without pruning, the
 * `FOR UPDATE SKIP LOCKED` claims scan an ever-growing table for the same
 * handful of pending rows. Deliveries and their receipts go with their
 * event, in the event's own statement and not by cascade (F5-05) — the
 * FAILED ones copied to notification_dead_letter in the same statement,
 * where they stay 90 days (publishedPurgeBatchSql).
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
    const deadline = purgeDeadline();

    const publishedBefore = new Date(
      Date.now() - PUBLISHED_RETENTION_DAYS * DAY_MS,
    );

    const failedBefore = new Date(
      Date.now() - env.OUTBOX_FAILED_RETENTION_DAYS * DAY_MS,
    );
    const executionsBefore = new Date(
      Date.now() - JOB_EXECUTION_RETENTION_DAYS * DAY_MS,
    );

    // The small purges first, the big one last (F1-17): they share one
    // budget, and the PUBLISHED purge alone can spend all of it. Each one
    // that stops with rows left makes the run partial, at the end.
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

    const goneReplicas = await databaseBatch.workerHeartbeat.deleteMany({
      where: {
        updated_at: {
          lt: new Date(Date.now() - HEARTBEAT_RETENTION_DAYS * DAY_MS),
        },
      },
    });

    const untiedReceipts = await deleteInBatches({
      table: Prisma.sql`"notification_provider_receipt"`,
      where: Prisma.sql`"deliveryId" IS NULL AND "created_at" < ${new Date(
        Date.now() - UNTIED_RECEIPT_RETENTION_DAYS * DAY_MS,
      )}`,
      maxRows: MAX_UNTIED_RECEIPTS_PER_RUN,
      deadline,
    });

    // The archives' own retention, counted from the failure. failedAt is
    // indexed, so the scan starts at the oldest rows and stops at the batch.
    const archiveExpired = await deleteInBatches({
      table: Prisma.sql`"notification_dead_letter"`,
      where: Prisma.sql`"failedAt" < ${failedBefore}`,
      orderBy: Prisma.sql`"failedAt"`,
      maxRows: MAX_FAILED_PER_RUN,
      deadline,
    });

    const eventArchiveExpired = await deleteInBatches({
      table: Prisma.sql`"outbox_event_dead_letter"`,
      where: Prisma.sql`"failedAt" < ${failedBefore}`,
      orderBy: Prisma.sql`"failedAt"`,
      maxRows: MAX_FAILED_PER_RUN,
      deadline,
    });

    // FAILED events leave the queue table at the PUBLISHED events' age,
    // copied to their dead letter (F5-10).
    const failed = await purgeEvents({
      batchSql: (limit) =>
        failedPurgeBatchSql(publishedBefore, failedBefore, limit),
      due: dueFailedSql(publishedBefore),
      maxRows: MAX_FAILED_PER_RUN,
      deadline,
    });

    // The keys the FAILED moves left without their event (F5-02).
    const orphanKeys = await deleteInBatches({
      table: Prisma.sql`"outbox_event_key"`,
      where: orphanKeysSql(failedBefore),
      orderBy: Prisma.sql`"created_at"`,
      key: Prisma.sql`"event_key"`,
      maxRows: MAX_ORPHAN_KEYS_PER_RUN,
      deadline,
    });

    // Each batch copies the failed deliveries of the events it deletes and
    // deletes the deliveries and their receipts, in the same statement
    // (publishedPurgeBatchSql).
    const published = await purgeEvents({
      batchSql: (limit) => publishedPurgeBatchSql(publishedBefore, limit),
      due: duePublishedSql(publishedBefore),
      maxRows: MAX_PUBLISHED_PER_RUN,
      deadline,
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
        orphanOutboxKeys: orphanKeys.deleted,
        cronExecutions: executions.deleted + heartbeatExecutions.deleted,
        archivedDeadLetters: published.archived,
        expiredDeadLetters: archiveExpired.deleted,
        archivedFailedEvents: failed.archived,
        expiredFailedEvents: eventArchiveExpired.deleted,
      },
      "notification pipeline purged",
    );

    // Every purge above ran; one that stopped with rows left makes the run
    // FAILED "[partial]", for the catch-up sweep's partial window.
    throwIfPartial({
      "scheduled_job_execution (30 dias)": executions,
      "scheduled_job_execution (ops-heartbeat)": heartbeatExecutions,
      notification_provider_receipt: untiedReceipts,
      notification_dead_letter: archiveExpired,
      outbox_event_dead_letter: eventArchiveExpired,
      "domain_outbox_event (FAILED)": failed,
      outbox_event_key: orphanKeys,
      "domain_outbox_event (PUBLISHED)": published,
    });
  },
};

export {
  cleanupNotificationPipelineJob,
  failedPurgeBatchSql,
  publishedPurgeBatchSql,
};
