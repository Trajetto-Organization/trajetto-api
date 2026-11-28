import { injectable } from "tsyringe";

import { Prisma } from "@prisma/client";

import { logger } from "@/shared/logging/logger";

import { withoutRequestContext } from "@/shared/http/request-context";
import { announceWake } from "@/shared/wake/wake-bus";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
  fanOutWebhookEvents,
} from "./webhook-dispatch-service";
import type { WebhookTopic } from "./webhook-catalogue";

const log = logger.child({ component: "webhook-fan-out" });

/**
 * How long after the fan-out the dispatcher is woken: the rows are written
 * in the caller's transaction, which commits after this returns. The same
 * half second the outbox waits (outbox-service.ts); a wake that comes
 * before the commit finds nothing and the sweep takes the rows.
 */
const WAKE_AFTER_COMMIT_MS = 500;

/**
 * The webhooks no longer wait for the 5 s sweep (plano-escala F3-04): this
 * process's dispatcher, when it runs one, and the processes that claim the
 * queue, by the wake hint. Outside the request (INV-12), unref'd, and never
 * a failure of the operation that announced.
 */
function wakeWebhooksAfterCommit(): void {
  withoutRequestContext(() => {
    const timer = setTimeout(() => {
      try {
        WebhookDispatchService.getInstance().wake();
        announceWake("webhooks");
      } catch (error) {
        log.warn({ err: error }, "webhook dispatcher could not be woken");
      }
    }, WAKE_AFTER_COMMIT_MS);

    timer.unref();
  });
}

/**
 * Telling the customers' systems that something happened, as an injected
 * dependency rather than a module-level call.
 *
 * Every other outbound concern in this product is injected — the outbox, the
 * notification service, the upload service — and for the same reason: a use
 * case that reaches a module singleton is a use case whose tests cannot say
 * what it sent. The first version of this was a bare function, and the unit
 * suite immediately showed why that was wrong: it went straight at the Prisma
 * client, which the tests replace with a fake that has exactly the two methods
 * the use case used to need.
 *
 * Which events fire stays EXPLICIT at each call site. Deriving them from an
 * internal topic name would mean a rename inside the product silently changes
 * what a customer's ERP receives, and an event added for our own reasons
 * silently becomes a published promise.
 */
@injectable()
class WebhookFanOutService {
  /**
   * Inside the caller's transaction when there is one.
   *
   * A webhook about a write that rolled back is a lie somebody's ERP acts on,
   * so the row is written with the same commit as the fact it describes.
   * Without a transaction the failure is swallowed and logged: a dispatcher
   * releasing a route does not care that a customer has no endpoint
   * configured, and an integration must never be able to fail an operation.
   */
  async announce(
    topic: WebhookTopic,
    businessId: string,
    payload: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    try {
      const queued = await fanOutWebhookEvent(
        { topic, businessId, payload },
        tx,
      );

      if (queued > 0) wakeWebhooksAfterCommit();
    } catch (error) {
      if (tx) throw error;

      log.error(
        { err: error, topic, businessId },
        "webhook event could not be queued",
      );
    }
  }

  /**
   * One topic for many documents of one company — a route's departure says
   * `delivery.in_transit` for each delivery that left — in a few statements
   * instead of three per event (fanOutWebhookEvents). Same rules as
   * `announce`: inside the caller's transaction it throws with it.
   */
  async announceMany(
    topic: WebhookTopic,
    businessId: string,
    payloads: Array<Record<string, unknown>>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (payloads.length === 0) return;

    try {
      const queued = await fanOutWebhookEvents(
        payloads.map((payload) => ({ topic, businessId, payload })),
        tx,
      );

      if (queued > 0) wakeWebhooksAfterCommit();
    } catch (error) {
      if (tx) throw error;

      log.error(
        { err: error, topic, businessId, events: payloads.length },
        "webhook events could not be queued",
      );
    }
  }
}

export { WebhookFanOutService };
