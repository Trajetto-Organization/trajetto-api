import { injectable } from "tsyringe";

import { Prisma } from "@prisma/client";

import { logger } from "@/shared/logging/logger";

import { fanOutWebhookEvent } from "./webhook-dispatch-service";
import type { WebhookTopic } from "./webhook-catalogue";

const log = logger.child({ component: "webhook-fan-out" });

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
      await fanOutWebhookEvent({ topic, businessId, payload }, tx);
    } catch (error) {
      if (tx) throw error;

      log.error(
        { err: error, topic, businessId },
        "webhook event could not be queued",
      );
    }
  }
}

export { WebhookFanOutService };
