import { Prisma } from "@prisma/client";

import {
  deleteInBatches,
  type BatchDeleteClient,
} from "@/shared/database/batch-delete";
import type {
  PartitionDropGate,
  PartitionToDrop,
} from "@/shared/database/partition-drop-gate";
import { queueLegacyBound } from "@/shared/database/queue-legacy-bound";
import { logger } from "@/shared/logging/logger";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

const log = logger.child({ component: "notification-family-retention" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The notification family: the events, their deliveries and the receipts.
 * A delivery's id carries its event's millisecond and a receipt's its
 * delivery's (delivery-id.ts, receipt-id.ts), so one range of ids is one
 * set of events with everything under them, in each of the three tables.
 */
const NOTIFICATION_FAMILY = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
] as const;

/** Rows copied per statement into a dead letter. */
const COPY_BATCH_SIZE = 1_000;

type FamilyClient = BatchDeleteClient;

/** `"id"` (of `alias`) inside [from, to); from null is the legacy's MINVALUE. */
function idRange(from: string | null, to: string, alias?: string): Prisma.Sql {
  const column = alias ? Prisma.raw(`"${alias}"."id"`) : Prisma.raw(`"id"`);

  return from === null
    ? Prisma.sql`${column} < ${to}`
    : Prisma.sql`${column} >= ${from} AND ${column} < ${to}`;
}

/**
 * Below which id every row of the family is still in a legacy partition
 * (queueLegacyBound), the bound of the purge in batches; null while any of
 * the three is a plain table, and the purge then keeps every row, as
 * before the swap.
 */
function notificationFamilyLegacyBound(
  db: FamilyClient,
): Promise<string | null> {
  return queueLegacyBound(db, NOTIFICATION_FAMILY);
}

/** Whether all three are partitioned: the gate drops nothing before it. */
async function familyPartitioned(db: FamilyClient): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ partitioned: number }>>`
    SELECT count(*)::int AS partitioned
    FROM unnest(${[...NOTIFICATION_FAMILY]}::text[]) AS t(name)
    JOIN pg_class p ON p.oid = to_regclass(quote_ident(t.name))
    WHERE p.relkind = 'p'
  `;

  return row?.partitioned === NOTIFICATION_FAMILY.length;
}

/**
 * A row in flight in the range: an event to expand, a delivery to send.
 * Each predicate is the one of a partial claim index, so the probe of a
 * day of millions reads a handful of entries. The receipts have no flight
 * of their own: they follow their deliveries.
 */
async function inFlight(
  db: FamilyClient,
  from: string | null,
  to: string,
): Promise<boolean> {
  const range = idRange(from, to);
  const [row] = await db.$queryRaw<Array<{ busy: boolean }>>`
    SELECT (
      EXISTS (
        SELECT 1 FROM "domain_outbox_event"
        WHERE ${range} AND "status" IN ('PENDING', 'PROCESSING')
      )
      OR EXISTS (
        SELECT 1 FROM "notification_delivery"
        WHERE ${range} AND "status" IN ('PENDING', 'PROCESSING')
          AND "channel" IN ('EMAIL', 'WHATSAPP')
      )
      OR EXISTS (
        SELECT 1 FROM "notification_delivery"
        WHERE ${range} AND "status" IN ('PENDING', 'PROCESSING')
          AND "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH')
      )
    ) AS busy
  `;

  return Boolean(row?.busy);
}

/**
 * One batch of the range's FAILED events into outbox_event_dead_letter,
 * with what their deliveries settled (the replay gives a recipient who had
 * the message nothing again): the same copy as the purge in batches
 * (failedPurgeBatchSql, cleanup-notification-pipeline-job.ts), without the
 * delete, which the DROP does. An event that failed before `keptFrom` is
 * past the dead letter's own retention and is not copied. Idempotent: the
 * dead letter's key is the event's id.
 */
function failedEventsCopySql(
  from: string | null,
  to: string,
  keptFrom: Date,
  after: string,
): Prisma.Sql {
  return Prisma.sql`
    WITH batch AS (
      SELECT
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "attempts", "lastError",
        "correlationId", "created_at", "updated_at"
      FROM "domain_outbox_event"
      WHERE ${idRange(from, to)} AND "status" = 'FAILED' AND "id" > ${after}
      ORDER BY "id"
      LIMIT ${COPY_BATCH_SIZE}
    ),
    archived AS (
      INSERT INTO "outbox_event_dead_letter" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "actorId", "payload", "attempts", "lastError",
        "correlationId", "created_at", "failedAt", "settled_deliveries"
      )
      SELECT
        b."id", b."eventKey", b."topic", b."aggregateType", b."aggregateId",
        b."businessId", b."actorId", b."payload", b."attempts", b."lastError",
        b."correlationId", b."created_at", b."updated_at",
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'userId', d."userId",
              'externalRecipientId', d."externalRecipientId",
              'channel', d."channel",
              'status', d."status",
              'attempts', d."attempts",
              'deliveredAt',
                (extract(epoch FROM d."deliveredAt") * 1000)::bigint,
              'lastError', d."lastError",
              'providerMessageId', d."providerMessageId",
              'providerStatus', d."providerStatus",
              'providerStatusAt',
                (extract(epoch FROM d."providerStatusAt") * 1000)::bigint
            )
            ORDER BY d."id"
          )
          FROM "notification_delivery" d
          WHERE d."outboxEventId" = b."id"
            AND ${idRange(from, to, "d")}
            AND d."status" IN ('DELIVERED', 'FAILED')
        )
      FROM batch b
      WHERE b."updated_at" >= ${keptFrom}
      ON CONFLICT ("id") DO NOTHING
      RETURNING 1
    )
    SELECT
      (SELECT max("id") FROM batch) AS last,
      (SELECT count(*) FROM batch)::int AS seen,
      (SELECT count(*) FROM archived)::int AS archived
  `;
}

/**
 * One batch of the range's FAILED deliveries of PUBLISHED events into
 * notification_dead_letter, as the PUBLISHED purge in batches does
 * (publishedPurgeBatchSql): the deliveries of a FAILED event are in its
 * own copy above. Idempotent: the dead letter's key is the delivery's id.
 */
function failedDeliveriesCopySql(
  from: string | null,
  to: string,
  after: string,
): Prisma.Sql {
  return Prisma.sql`
    WITH batch AS (
      SELECT *
      FROM "notification_delivery" d
      WHERE ${idRange(from, to, "d")} AND d."status" = 'FAILED'
        AND d."id" > ${after}
      ORDER BY d."id"
      LIMIT ${COPY_BATCH_SIZE}
    ),
    archived AS (
      INSERT INTO "notification_dead_letter" (
        "id", "outboxEventId", "topic", "businessId",
        "userId", "externalRecipientId", "channel", "attempts",
        "lastError", "providerMessageId", "created_at", "failedAt"
      )
      SELECT
        d."id", d."outboxEventId", e."topic", e."businessId",
        d."userId", d."externalRecipientId", d."channel", d."attempts",
        d."lastError", d."providerMessageId", d."created_at", d."updated_at"
      FROM batch d
      JOIN "domain_outbox_event" e
        ON e."id" = d."outboxEventId" AND ${idRange(from, to, "e")}
      WHERE e."status" = 'PUBLISHED'
      ON CONFLICT ("id") DO NOTHING
      RETURNING 1
    )
    SELECT
      (SELECT max("id") FROM batch) AS last,
      (SELECT count(*) FROM batch)::int AS seen,
      (SELECT count(*) FROM archived)::int AS archived
  `;
}

/** Runs a copy batch by batch, in id order, until one comes back short. */
async function copyAll(
  db: FamilyClient,
  batch: (after: string) => Prisma.Sql,
  deadline: number,
): Promise<{ archived: number; finished: boolean }> {
  let after = "";
  let archived = 0;

  for (;;) {
    if (Date.now() >= deadline) return { archived, finished: false };

    const [row] = await db.$queryRaw<
      Array<{ last: string | null; seen: number; archived: number }>
    >(batch(after));

    archived += row?.archived ?? 0;

    if (!row?.last || row.seen < COPY_BATCH_SIZE) {
      return { archived, finished: true };
    }

    after = row.last;
  }
}

interface NotificationFamilyGateOptions {
  db: FamilyClient;
  /** Epoch ms; past it, every day waits for the next night. */
  deadline: number;
  /** OUTBOX_FAILED_RETENTION_DAYS: a failure older is not copied. */
  failedRetentionDays: number;
  now?: () => Date;
}

/**
 * The gate the partition-maintenance job asks before it detaches a day of
 * the notification family past OUTBOX_PUBLISHED_RETENTION_DAYS
 * (plano-escala F5-11). A day goes only when:
 *
 *  - all three tables are partitioned: with one still plain, its rows of
 *    that day would outlive the other two's, and the purge in batches is
 *    the one that keeps the family together;
 *  - nothing in it is in flight (an event to expand, a delivery to send);
 *  - its failures are in the dead letters: the FAILED events with what
 *    their deliveries settled, the FAILED deliveries of the PUBLISHED ones,
 *    as the purge in batches copies them;
 *  - the keys of its PUBLISHED events are gone from outbox_event_key (a
 *    FAILED event's key stays, as in the purge in batches: the orphan-key
 *    sweep takes it once the failure leaves its dead letter).
 *
 * The first of the three partitions of a range to go does the copies and
 * the keys for the whole range, the other two tables' rows of it included
 * (they are all still there); the next ones find them done. Anything that
 * fails says no, logged: the day waits for the next night, and
 * partition-stuck says so after QUEUE_PARTITION_STUCK_ALERT_DAYS.
 */
function createNotificationFamilyGate(
  options: NotificationFamilyGateOptions,
): PartitionDropGate {
  const { db, deadline, failedRetentionDays } = options;
  const now = options.now ?? (() => new Date());
  const prepared = new Set<string>();
  let partitioned: Promise<boolean> | null = null;

  return {
    async mayDrop(parent: string, partition: PartitionToDrop) {
      const from = partition.from ? uuid7Floor(partition.from) : null;
      const to = uuid7Floor(partition.to);
      const what = { table: parent, partition: partition.name };

      try {
        if (!(await (partitioned ??= familyPartitioned(db)))) {
          log.warn(
            what,
            "notification family not all partitioned yet: the day is kept",
          );

          return false;
        }

        if (await inFlight(db, from, to)) {
          log.info(what, "notification family day still in flight: kept");

          return false;
        }

        const range = `${from ?? ""}|${to}`;

        if (prepared.has(range)) return true;

        const keptFrom = new Date(
          now().getTime() - failedRetentionDays * DAY_MS,
        );
        const events = await copyAll(
          db,
          (after) => failedEventsCopySql(from, to, keptFrom, after),
          deadline,
        );
        const deliveries = events.finished
          ? await copyAll(
              db,
              (after) => failedDeliveriesCopySql(from, to, after),
              deadline,
            )
          : { archived: 0, finished: false };

        // The keys of the range's PUBLISHED events. A key is written with
        // its event, so its created_at is within a day of the event's id;
        // the window keeps the walk on the created_at index. One written
        // outside it (a clock off by a day) is an orphan the nightly sweep
        // takes.
        const keys = deliveries.finished
          ? await deleteInBatches({
              client: db,
              table: Prisma.sql`"outbox_event_key"`,
              where: Prisma.sql`${
                from === null
                  ? Prisma.sql`"event_id" < ${to}`
                  : Prisma.sql`"event_id" >= ${from} AND "event_id" < ${to}
                      AND "created_at" >= ${new Date(
                        (partition.from as Date).getTime() - DAY_MS,
                      )}`
              } AND "created_at" < ${new Date(partition.to.getTime() + DAY_MS)}
                AND NOT EXISTS (
                  SELECT 1 FROM "domain_outbox_event" e
                  WHERE e."id" = "outbox_event_key"."event_id"
                    AND e."status" = 'FAILED'
                )`,
              orderBy: Prisma.sql`"created_at"`,
              key: Prisma.sql`"event_key"`,
              maxRows: Number.MAX_SAFE_INTEGER,
              deadline,
            })
          : { deleted: 0, stoppedEarly: true };

        if (!events.finished || !deliveries.finished || keys.stoppedEarly) {
          log.warn(
            what,
            "notification family day out of time: kept for the next night",
          );

          return false;
        }

        prepared.add(range);
        log.info(
          {
            ...what,
            failedEvents: events.archived,
            failedDeliveries: deliveries.archived,
            keys: keys.deleted,
          },
          "notification family day settled: failures copied, keys dropped",
        );

        return true;
      } catch (error) {
        log.warn(
          {
            ...what,
            error: error instanceof Error ? error.message : String(error),
          },
          "notification family day could not be prepared: kept",
        );

        return false;
      }
    },
  };
}

export {
  NOTIFICATION_FAMILY,
  createNotificationFamilyGate,
  notificationFamilyLegacyBound,
};
