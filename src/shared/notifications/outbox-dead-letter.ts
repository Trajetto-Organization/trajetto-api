import { NotificationChannel, Prisma } from "@prisma/client";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";

import database from "@/../infra/database";

import { deliveryIdFor } from "./delivery-id";

/**
 * The dead letter of outbox events (plano-escala F5-10): the events that
 * exhausted their expansions, wherever they are.
 *
 * A FAILED event stays in domain_outbox_event for 30 days, like a
 * PUBLISHED one; then the nightly purge moves it to
 * outbox_event_dead_letter (copy and delete, one statement:
 * failedPurgeBatchSql), where it is kept OUTBOX_FAILED_RETENTION_DAYS (90)
 * from the failure. The queues become partitioned by day (F5-09) and a day
 * is dropped whole (F5-11): a FAILED event cannot stay 90 days among rows
 * dropped at 30. For whoever looks, nothing changed: the listing reads both
 * places, and either kind can be replayed for the same 90 days.
 *
 * The replay of an event still in the queue table puts it back to PENDING,
 * where the expansion creates only the deliveries it never created. The
 * replay of a copy creates a NEW event from it (the original is gone): its
 * own id and a fresh key, the same topic, aggregate, company, actor,
 * payload and correlation id; the copy records which event it became and
 * leaves the listing, so a second click changes nothing.
 *
 * The new id (today's partition) means new delivery ids, and the move
 * deleted the original's deliveries. An event a replica expanded after
 * losing its lease, and that then failed under the new owner, had sent
 * them: a copy replayed bare would reach every recipient again. So the
 * move records the deliveries that went out or gave up
 * (settled_deliveries), and the replay gives them back to the new event,
 * under the ids its expansion computes (delivery-id.ts): the expansion
 * skips them as it skips a live event's, and creates only the rest.
 */

/** One delivery the archived event already had (settled_deliveries). */
interface SettledDelivery {
  userId: string | null;
  externalRecipientId: string | null;
  channel: NotificationChannel;
  status: "DELIVERED" | "FAILED";
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  /** Epoch ms, as the move wrote them: a JSON date would lose the zone. */
  deliveredAt: number | null;
  providerStatusAt: number | null;
}

const CHANNELS = new Set<string>(Object.values(NotificationChannel));

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const msOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The copy's settled deliveries. Written by the move's own SQL; an entry
 * that is not one (no single recipient, an unknown channel or status) is
 * left out, and the expansion creates that delivery as it would anyway.
 */
function settledDeliveriesOf(value: Prisma.JsonValue): SettledDelivery[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): SettledDelivery[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const userId = textOrNull(entry.userId);
    const externalRecipientId = textOrNull(entry.externalRecipientId);
    const { channel, status, attempts } = entry;

    if (Boolean(userId) === Boolean(externalRecipientId)) return [];
    if (typeof channel !== "string" || !CHANNELS.has(channel)) return [];
    if (status !== "DELIVERED" && status !== "FAILED") return [];

    return [
      {
        userId,
        externalRecipientId,
        channel: channel as NotificationChannel,
        status,
        attempts: typeof attempts === "number" ? attempts : 0,
        lastError: textOrNull(entry.lastError),
        providerMessageId: textOrNull(entry.providerMessageId),
        providerStatus: textOrNull(entry.providerStatus),
        deliveredAt: msOrNull(entry.deliveredAt),
        providerStatusAt: msOrNull(entry.providerStatusAt),
      },
    ];
  });
}

/**
 * Gives a recreated event the deliveries its original already settled,
 * with their status, attempts and provider's id, under the ids the new
 * event's expansion computes for them. A recipient deleted since is left
 * out: the expansion no longer reaches them either, and the row would
 * break the foreign key (until wave 10 drops it). Returns how many.
 */
async function restoreSettledDeliveries(
  tx: Prisma.TransactionClient,
  event: { id: string; created_at: Date },
  businessId: string | null,
  settled: SettledDelivery[],
): Promise<number> {
  if (settled.length === 0) return 0;

  const userIds = [
    ...new Set(settled.flatMap((row) => (row.userId ? [row.userId] : []))),
  ];
  const externalIds = [
    ...new Set(
      settled.flatMap((row) =>
        row.externalRecipientId ? [row.externalRecipientId] : [],
      ),
    ),
  ];

  const users =
    userIds.length > 0
      ? await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true },
        })
      : [];
  const externals =
    externalIds.length > 0
      ? await tx.externalRecipient.findMany({
          where: { id: { in: externalIds } },
          select: { id: true },
        })
      : [];

  const present = new Set([
    ...users.map((row) => `user:${row.id}`),
    ...externals.map((row) => `external:${row.id}`),
  ]);

  const rows = settled.filter((row) =>
    present.has(
      row.userId ? `user:${row.userId}` : `external:${row.externalRecipientId}`,
    ),
  );

  if (rows.length === 0) return 0;

  const { count } = await tx.notificationDelivery.createMany({
    data: rows.map((row) => ({
      id: deliveryIdFor(event, row, row.channel),
      outboxEventId: event.id,
      userId: row.userId,
      externalRecipientId: row.externalRecipientId,
      channel: row.channel,
      business_id: businessId,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      providerMessageId: row.providerMessageId,
      providerStatus: row.providerStatus,
      deliveredAt: row.deliveredAt === null ? null : new Date(row.deliveredAt),
      providerStatusAt:
        row.providerStatusAt === null ? null : new Date(row.providerStatusAt),
    })),
    skipDuplicates: true,
  });

  return count;
}

/** One row of the listing: an event that gave up, in either place. */
interface FailedEventRow {
  id: string;
  topic: string;
  businessId: string | null;
  attempts: number;
  lastError: string | null;
  created_at: Date;
  failedAt: Date;

  /** True for a copy in outbox_event_dead_letter: a replay creates a new event. */
  archived: boolean;
}

interface FailedEventPage {
  rows: FailedEventRow[];
  total: number;
}

/**
 * The live FAILED events and the copies not replayed yet, newest failure
 * first. An event is in one place at a time: the move copies and deletes
 * in one statement.
 */
async function listFailedEvents(
  page: number,
  pageSize: number,
): Promise<FailedEventPage> {
  const [{ live, archived }] = await database.$queryRaw<
    Array<{ live: number; archived: number }>
  >`
    SELECT
      (SELECT count(*) FROM "domain_outbox_event"
       WHERE "status" = 'FAILED')::int AS live,
      (SELECT count(*) FROM "outbox_event_dead_letter"
       WHERE "replayed_at" IS NULL)::int AS archived
  `;

  const rows = await database.$queryRaw<FailedEventRow[]>`
    SELECT * FROM (
      SELECT
        "id", "topic", "businessId", "attempts", "lastError", "created_at",
        "updated_at" AS "failedAt", false AS "archived"
      FROM "domain_outbox_event"
      WHERE "status" = 'FAILED'
      UNION ALL
      SELECT
        "id", "topic", "businessId", "attempts", "lastError", "created_at",
        "failedAt", true AS "archived"
      FROM "outbox_event_dead_letter"
      WHERE "replayed_at" IS NULL
    ) failed
    ORDER BY "failedAt" DESC, "id" DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `;

  return { rows, total: live + archived };
}

interface ReplayResult {
  /** Live FAILED events put back to PENDING. */
  requeued: number;

  /**
   * Copies of the dead letter that became a new event, by copy id, with
   * how many of the original's settled deliveries the new event got back.
   */
  recreated: Array<{
    archivedId: string;
    eventId: string;
    restoredDeliveries: number;
  }>;
}

/**
 * Sends the given events through the expansion again: the live FAILED ones
 * back to PENDING, the copies as new events. Ids in any other state (a
 * live event no longer FAILED, a copy already replayed, an unknown id) are
 * left alone. One transaction: the copies are locked, so two replays of
 * the same copy at once create one event.
 */
async function replayFailedEvents(
  eventIds: string[],
  replayedBy: string,
): Promise<ReplayResult> {
  const now = new Date();

  return database.$transaction(async (tx) => {
    const live = await tx.domainOutboxEvent.updateMany({
      where: { id: { in: eventIds }, status: "FAILED" },
      data: {
        status: "PENDING",
        attempts: 0,
        availableAt: now,
        leaseExpiresAt: null,
        lastError: `Reenfileirado manualmente em ${now.toISOString()} por ${replayedBy}`,
      },
    });

    const copies = await tx.$queryRaw<
      Array<{
        id: string;
        topic: string;
        aggregateType: string;
        aggregateId: string;
        businessId: string | null;
        actorId: string | null;
        payload: Prisma.JsonValue;
        correlationId: string | null;
        settled_deliveries: Prisma.JsonValue;
      }>
    >`
      SELECT
        "id", "topic", "aggregateType", "aggregateId", "businessId",
        "actorId", "payload", "correlationId", "settled_deliveries"
      FROM "outbox_event_dead_letter"
      WHERE "id" IN (${Prisma.join(eventIds)}) AND "replayed_at" IS NULL
      ORDER BY "id"
      FOR UPDATE
    `;

    const recreated: ReplayResult["recreated"] = [];

    for (const copy of copies) {
      const eventId = uuidv7();

      const created = await tx.domainOutboxEvent.create({
        data: {
          id: eventId,
          // A fresh key: the original's may still be held by
          // outbox_event_key, and a replay is a new publication.
          eventKey: `${copy.topic}:${copy.aggregateId}:${uuidv4()}`,
          topic: copy.topic,
          aggregateType: copy.aggregateType,
          aggregateId: copy.aggregateId,
          businessId: copy.businessId,
          actorId: copy.actorId,
          payload: (copy.payload ?? {}) as Prisma.InputJsonValue,
          correlationId: copy.correlationId,
          lastError: `Recriado do dead letter (evento ${copy.id}) em ${now.toISOString()} por ${replayedBy}`,
        },
        select: { id: true, created_at: true },
      });

      // In the same transaction as the event: the pipeline never sees it
      // without them, so its expansion never sends them again.
      const restoredDeliveries = await restoreSettledDeliveries(
        tx,
        created,
        copy.businessId,
        settledDeliveriesOf(copy.settled_deliveries),
      );

      await tx.outboxEventDeadLetter.update({
        where: { id: copy.id },
        data: { replayed_at: now, replayed_event_id: eventId },
      });

      recreated.push({ archivedId: copy.id, eventId, restoredDeliveries });
    }

    return { requeued: live.count, recreated };
  });
}

export { listFailedEvents, replayFailedEvents, settledDeliveriesOf };
export type { FailedEventPage, FailedEventRow, ReplayResult, SettledDelivery };
