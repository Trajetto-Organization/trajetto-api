import { Prisma } from "@prisma/client";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";

import database from "@/../infra/database";

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
 */

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

  /** Copies of the dead letter that became a new event, by copy id. */
  recreated: Array<{ archivedId: string; eventId: string }>;
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
      }>
    >`
      SELECT
        "id", "topic", "aggregateType", "aggregateId", "businessId",
        "actorId", "payload", "correlationId"
      FROM "outbox_event_dead_letter"
      WHERE "id" IN (${Prisma.join(eventIds)}) AND "replayed_at" IS NULL
      ORDER BY "id"
      FOR UPDATE
    `;

    const recreated: ReplayResult["recreated"] = [];

    for (const copy of copies) {
      const eventId = uuidv7();

      await tx.domainOutboxEvent.create({
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
      });

      await tx.outboxEventDeadLetter.update({
        where: { id: copy.id },
        data: { replayed_at: now, replayed_event_id: eventId },
      });

      recreated.push({ archivedId: copy.id, eventId });
    }

    return { requeued: live.count, recreated };
  });
}

export { listFailedEvents, replayFailedEvents };
export type { FailedEventPage, FailedEventRow, ReplayResult };
