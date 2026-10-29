import { Prisma } from "@prisma/client";
import { injectable } from "tsyringe";

import { v4 as uuidv4 } from "uuid";

import database from "@/../infra/database";
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

        // The id of the request that published it — the same one its log
        // lines and its x-request-id carry — so a delivery can be followed
        // back to it (OBS-06). Null from a cron or a worker, which run with
        // no request context.
        correlationId:
          input.correlationId ?? getRequestContext()?.requestId ?? null,
      },
    });
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
