import { Prisma } from "@prisma/client";
import { injectable } from "tsyringe";

import { v4 as uuidv4, v7 as uuidv7 } from "uuid";

import database from "@/../infra/database";
import { customerStopGroup } from "@/shared/delivery/customer-notice";
import {
  getRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";

import { NotificationTopic, TopicPayloadMap } from "./notification-types";

interface PublishEventInput<T extends NotificationTopic> {
  topic: T;
  aggregateType: string;
  aggregateId: string;
  businessId?: string | null;
  actorId?: string | null;
  payload: TopicPayloadMap[T];

  /**
   * Natural idempotency key when the caller has one (e.g. a client
   * submission id). Defaults to a random key: the event is then unique per
   * use-case execution, which is already deduplicated upstream.
   */
  eventKey?: string;

  /**
   * What caused this event, for tracing. Defaults to the id of the request
   * being served (see `createEventRow`); pass one only to override it.
   */
  correlationId?: string | null;
}

/**
 * How one event gathers several (plan of 02/11/2026, B6: one customer
 * message per stop, not per NF-e).
 */
interface MergedPublishOptions {
  /** The group's key: every publish under it lands on one row. */
  mergeKey: string;

  /**
   * The array in the payload the merge appends to (each publish brings its
   * own entries). The first publish's payload is kept otherwise.
   */
  mergeField: string;

  /**
   * The entry field that identifies one: an entry already in the row is not
   * added twice (a replay, or every sibling bringing the whole group).
   */
  mergeIdentity: string;

  /** Hold the row this long before the pipeline may take it (the window). */
  delayMs?: number;

  /**
   * What a publish does when the group's row was already taken by the
   * pipeline: "separate" publishes it on its own (a sibling resolved after
   * the window), "skip" drops it (the customer was already told this).
   */
  whenTaken: "separate" | "skip";
}

/**
 * The only way a use case emits a notification.
 *
 * `publish` takes the transaction client of the business write, so the event
 * exists if and only if the write committed — a crash can no longer lose a
 * notification (the old fire-and-forget) nor announce a record that was
 * rolled back. Everything after the commit is the pipeline's job.
 */
@injectable()
class OutboxService {
  async publish<T extends NotificationTopic>(
    tx: Prisma.TransactionClient,
    input: PublishEventInput<T>,
  ): Promise<void> {
    // The four customer moments go out once per stop, not per NF-e (plan of
    // 02/11/2026, B6): a delivery whose stop has siblings publishes into the
    // group's row. Every other event, and a stop of its own, as always.
    const grouped = await customerStopGroup(tx, input);

    if (grouped) {
      await this.publishMerged(
        tx,
        { ...input, payload: grouped.payload as TopicPayloadMap[T] },
        {
          mergeKey: grouped.mergeKey,
          mergeField: "deliveries",
          mergeIdentity: "deliveryId",
          delayMs: grouped.delayMs,
          whenTaken: grouped.whenTaken,
        },
      );

      return;
    }

    await this.createEventRow(tx, input);

    // Wake the pipeline shortly after the surrounding transaction has had
    // time to commit, so the event is delivered in milliseconds instead of
    // waiting for the background sweep. Timing is best-effort on purpose: if
    // the wake fires before the commit (or the commit rolls back), the claim
    // simply finds nothing and the sweep remains the safety net.
    this.wakePipeline(500);
  }

  /**
   * Publishes into a GROUP's row, in the caller's transaction (plan of
   * 02/11/2026, B6). The first publish under `mergeKey` creates the row,
   * available after `delayMs`; every publish after it, while the row still
   * waits (PENDING), appends its `mergeField` entries to it instead of
   * creating another. The group is held by its key's row in
   * outbox_event_key (plano-escala F5-02), an INSERT ... ON CONFLICT
   * RETURNING, then an UPDATE of the event it names: two replicas (or two
   * transactions) publishing the same group serialize on the key and both
   * land in one row, with or without the legacy unique on the event's
   * eventKey. Once the pipeline took the row, a publish goes out on its own
   * or is dropped (`whenTaken`).
   *
   * Returns whether a row was written (false only for a dropped one).
   */
  async publishMerged<T extends NotificationTopic>(
    tx: Prisma.TransactionClient,
    input: PublishEventInput<T>,
    options: MergedPublishOptions,
  ): Promise<boolean> {
    const delayMs = options.delayMs ?? 0;
    const availableAt = new Date(Date.now() + delayMs);
    const payload = input.payload as unknown as Record<string, unknown>;
    const entries = payload[options.mergeField] ?? [];
    const id = uuidv7();

    // The path is a fixed identifier from the caller, never input.
    const path = `{${options.mergeField}}`;

    // The group's key first (plano-escala F5-02): its own row in
    // outbox_event_key, taken or found in one statement. A second publisher
    // of the same group waits here for the first one's commit (the key's
    // row lock), then finds the row the first one wrote: two transactions
    // publishing one group land on one event, whatever the event table's
    // own indexes are.
    const [key] = await tx.$queryRaw<Array<{ event_id: string }>>`
      INSERT INTO "outbox_event_key" ("event_key", "event_id")
      VALUES (${options.mergeKey}, ${id})
      ON CONFLICT ("event_key") DO UPDATE SET "event_key" = EXCLUDED."event_key"
      RETURNING "event_id"
    `;

    let target: string | null = key.event_id;

    if (target === id) {
      // The group's first publish: its row, available after the window.
      // ON CONFLICT with no target: while the legacy unique on eventKey
      // exists, a row the previous image wrote for this group (no key row
      // of its own: the rolling deploy) makes this a no-op, and the key is
      // pointed at that row below.
      const created = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "domain_outbox_event" (
          "id", "eventKey", "topic", "aggregateType", "aggregateId",
          "businessId", "actorId", "payload", "availableAt", "correlationId",
          "updated_at"
        ) VALUES (
          ${id}, ${options.mergeKey}, ${input.topic},
          ${input.aggregateType}, ${input.aggregateId},
          ${input.businessId ?? null}, ${input.actorId ?? null},
          ${JSON.stringify(payload)}::jsonb, ${availableAt},
          ${input.correlationId ?? getRequestContext()?.requestId ?? null},
          now()
        )
        ON CONFLICT DO NOTHING
        RETURNING "id"
      `;

      if (created.length > 0) {
        this.wakePipeline(delayMs + 500);
        return true;
      }

      target = await this.adoptLegacyEvent(tx, options.mergeKey);
    }

    // A later publish of the group: its entries go into the row while the
    // row still waits for the window (PENDING).
    const rows = target
      ? await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "domain_outbox_event" SET
            "payload" = jsonb_set(
              "domain_outbox_event"."payload",
              ${path}::text[],
              (
                -- The entries already there, then the new ones, each
                -- identity once, in the order first seen.
                SELECT COALESCE(jsonb_agg("entry" ORDER BY "seen"), '[]'::jsonb)
                FROM (
                  SELECT DISTINCT ON ("identity") "entry", "seen"
                  FROM (
                    SELECT "entry", "seen", "entry" ->> ${options.mergeIdentity} AS "identity"
                    FROM jsonb_array_elements(
                      COALESCE("domain_outbox_event"."payload" -> ${options.mergeField}, '[]'::jsonb)
                        || ${JSON.stringify(entries)}::jsonb
                    ) WITH ORDINALITY AS "merged"("entry", "seen")
                  ) AS "identified"
                  ORDER BY "identity", "seen"
                ) AS "unique_entries"
              )
            ),
            "updated_at" = now()
          WHERE "domain_outbox_event"."id" = ${target}
            AND "domain_outbox_event"."status" = 'PENDING'
          RETURNING "id"
        `
      : [];

    if (rows.length > 0) {
      this.wakePipeline(delayMs + 500);
      return true;
    }

    // The group's row is already with the pipeline (or done).
    if (options.whenTaken === "skip") return false;

    // On its own, under a key of its own: never back through the grouping.
    await this.createEventRow(tx, { ...input, eventKey: undefined });
    this.wakePipeline(500);

    return true;
  }

  /**
   * Publishes without a surrounding transaction. Only for a caller that
   * closes the write-to-event gap on its own: today the AI pipeline, which
   * publishes BEFORE settling its request, under a deterministic eventKey,
   * so a crash in between re-claims the request and the re-publish hits the
   * unique key instead of doubling the alert.
   *
   * Everything else uses `publish` inside the write's transaction. The plan
   * changes and the audit trail used to come through here and lost their
   * event whenever the database failed between the two commits (OUTBOX-10);
   * the audit trail is now written directly (NotificationService).
   */
  async publishAfterCommit<T extends NotificationTopic>(
    input: PublishEventInput<T>,
  ): Promise<void> {
    // A caller's key is two rows (F5-02): one transaction of their own.
    if (input.eventKey) {
      await database.$transaction((tx) => this.createEventRow(tx, input));
    } else {
      await this.createEventRow(database, input);
    }

    this.wakePipeline(0);
  }

  /**
   * Publishes an event at most once per `eventKey`, with no surrounding
   * transaction: for a notice whose only write is the event itself (wave
   * 3.7: a driver's route record refused for want of an active branch, told
   * to the dispatcher). The key's row in outbox_event_key is taken first
   * (plano-escala F5-02), ON CONFLICT DO NOTHING RETURNING: the caller's
   * retries — and two replicas answering them at once — write one row and
   * never fail on the key, with or without the legacy unique on the
   * event's eventKey. Once per key for as long as the row is kept
   * (PUBLISHED rows and their keys are purged after 30 days).
   *
   * Returns whether this call wrote the row.
   */
  async publishOnce<T extends NotificationTopic>(
    input: PublishEventInput<T> & { eventKey: string },
  ): Promise<boolean> {
    const id = uuidv7();

    const wrote = await database.$transaction(async (tx) => {
      const taken = await tx.$queryRaw<Array<{ event_id: string }>>`
        INSERT INTO "outbox_event_key" ("event_key", "event_id")
        VALUES (${input.eventKey}, ${id})
        ON CONFLICT ("event_key") DO NOTHING
        RETURNING "event_id"
      `;

      if (taken.length === 0) return false;

      // ON CONFLICT DO NOTHING with no target: a row the previous image
      // wrote under this key (no key row of its own: the rolling deploy)
      // makes it a no-op while the legacy unique exists.
      const { count } = await tx.domainOutboxEvent.createMany({
        data: [{ ...this.eventRow(input), id }],
        skipDuplicates: true,
      });

      if (count > 0) return true;

      await this.adoptLegacyEvent(tx, input.eventKey);

      return false;
    });

    if (wrote) this.wakePipeline(0);

    return wrote;
  }

  /**
   * The event row of an outbox write. A key the caller gave (a submission
   * id, a deterministic notice key) also gets its row in outbox_event_key
   * (plano-escala F5-02), through the model and in the same transaction:
   * the queues are partitioned by day on their id later in the plan, where
   * the global unique on eventKey cannot stay, and that row is what keeps
   * "already published" a P2002 for the caller. The random key of an event
   * without one never collides and gets no row.
   */
  private async createEventRow<T extends NotificationTopic>(
    client: Prisma.TransactionClient,
    input: PublishEventInput<T>,
  ): Promise<void> {
    if (!input.eventKey) {
      await client.domainOutboxEvent.create({ data: this.eventRow(input) });
      return;
    }

    const id = uuidv7();

    await client.domainOutboxEvent.create({
      data: { ...this.eventRow(input), id },
    });
    await client.outboxEventKey.create({
      data: { event_key: input.eventKey, event_id: id },
    });
  }

  /**
   * Points a key at the event the previous image wrote under it without a
   * key row (the rolling deploy), and returns that event's id; null when
   * there is none. Goes with the legacy unique (plano-escala F5-06).
   */
  private async adoptLegacyEvent(
    tx: Prisma.TransactionClient,
    eventKey: string,
  ): Promise<string | null> {
    const [legacy] = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "outbox_event_key" k
      SET "event_id" = e."id"
      FROM "domain_outbox_event" e
      WHERE k."event_key" = ${eventKey} AND e."eventKey" = ${eventKey}
      RETURNING e."id"
    `;

    return legacy?.id ?? null;
  }

  private eventRow<T extends NotificationTopic>(
    input: PublishEventInput<T>,
  ): Prisma.DomainOutboxEventCreateManyInput {
    return {
      eventKey:
        input.eventKey ?? `${input.topic}:${input.aggregateId}:${uuidv4()}`,
      topic: input.topic,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      businessId: input.businessId ?? null,
      actorId: input.actorId ?? null,
      payload: input.payload as unknown as Prisma.InputJsonValue,

      // The id of the request that published it — the same one its log
      // lines and its x-request-id carry — so a delivery can be followed
      // back to it (OBS-06). Null from a cron or a worker, which run with
      // no request context.
      correlationId:
        input.correlationId ?? getRequestContext()?.requestId ?? null,
    };
  }

  private wakePipeline(delayMs: number): void {
    // The timer is created outside the publishing request (INV-12): created
    // inside it, AsyncLocalStorage kept the request's store alive until the
    // timer fired and handed it to everything the callback started.
    withoutRequestContext(() => {
      setTimeout(() => {
        import("./notification-pipeline-service")
          .then(({ NotificationPipelineService }) => {
            NotificationPipelineService.getInstance().wake();
          })
          .catch((error) => {
            logger.error(
              { err: error, component: "outbox" },
              "the notification pipeline could not be woken",
            );
          });
      }, delayMs);
    });
  }
}

export { OutboxService, PublishEventInput };
export type { MergedPublishOptions };
