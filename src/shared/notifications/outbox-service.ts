import { Prisma } from "@prisma/client";
import { injectable } from "tsyringe";

import { v4 as uuidv4 } from "uuid";

import database from "@/../infra/database";
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
    await this.createEventRow(tx, input);

    // Wake the pipeline shortly after the surrounding transaction has had
    // time to commit, so the event is delivered in milliseconds instead of
    // waiting for the background sweep. Timing is best-effort on purpose: if
    // the wake fires before the commit (or the commit rolls back), the claim
    // simply finds nothing and the sweep remains the safety net.
    this.wakePipeline(500);
  }

  /**
   * Publishes without a surrounding transaction, for call sites whose
   * business write has already committed — today, the fire-and-forget
   * audit-trail path. The write-to-event gap this leaves open is exactly the
   * one that path always had; user-facing notifications must keep using
   * `publish` inside the write's transaction instead.
   */
  async publishAfterCommit<T extends NotificationTopic>(
    input: PublishEventInput<T>,
  ): Promise<void> {
    await this.createEventRow(database, input);
    this.wakePipeline(0);
  }

  private async createEventRow<T extends NotificationTopic>(
    client: Prisma.TransactionClient,
    input: PublishEventInput<T>,
  ): Promise<void> {
    await client.domainOutboxEvent.create({
      data: {
        eventKey:
          input.eventKey ?? `${input.topic}:${input.aggregateId}:${uuidv4()}`,
        topic: input.topic,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        businessId: input.businessId ?? null,
        actorId: input.actorId ?? null,
        payload: input.payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private wakePipeline(delayMs: number): void {
    setTimeout(() => {
      import("./notification-pipeline-service")
        .then(({ NotificationPipelineService }) => {
          NotificationPipelineService.getInstance().wake();
        })
        .catch((error) => {
          console.error("[Outbox] Falha ao acordar o pipeline:", error);
        });
    }, delayMs);
  }
}

export { OutboxService, PublishEventInput };
