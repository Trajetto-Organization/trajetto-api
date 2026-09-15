import type { Prisma } from "@prisma/client";

import type { WebhookTopic } from "../webhook-catalogue";
import type { WebhookFanOutService } from "../webhook-fan-out-service";

interface AnnouncedEvent {
  topic: WebhookTopic;
  businessId: string;
  payload: Record<string, unknown>;

  /** Whether the caller handed over a transaction client. */
  transactional: boolean;
}

/**
 * The fan-out a unit test can interrogate.
 *
 * Every other outbound dependency here is stubbed inline with an empty method,
 * and that was fine while the only thing at stake was "does it not throw".
 * This one records, because the question a webhook raises is not whether it
 * ran but WHICH topic it sent and with what inside — a route that closed and
 * announced `route.started` would pass an empty stub and break every
 * subscriber.
 *
 * The real service reaches the Prisma singleton through `fanOutWebhookEvent`.
 * Unit tests replace that singleton with a fake carrying `$transaction` and
 * nothing else, so the real one crashes there; this exists so a use case's
 * tests never reach the database at all.
 */
class InMemoryWebhookFanOutService {
  readonly announced: AnnouncedEvent[] = [];

  /**
   * Set to make the next announce throw, for the tests that ask what a use
   * case does when an integration is unreachable. The answer must always be
   * "finishes anyway": a customer's broken endpoint cannot fail our write.
   */
  failNext = false;

  async announce(
    topic: WebhookTopic,
    businessId: string,
    payload: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;

      throw new Error("integration unreachable");
    }

    this.announced.push({
      topic,
      businessId,
      payload,
      transactional: Boolean(tx),
    });
  }

  topics(): WebhookTopic[] {
    return this.announced.map((event) => event.topic);
  }

  /** The events for one topic, for a test that asserts on the payload. */
  forTopic(topic: WebhookTopic): AnnouncedEvent[] {
    return this.announced.filter((event) => event.topic === topic);
  }

  reset(): void {
    this.announced.length = 0;
    this.failNext = false;
  }

  /**
   * The use cases take the concrete class, as they do for every other service
   * in this product. This keeps the cast in one place instead of at each of
   * the twenty-odd construction sites.
   */
  asService(): WebhookFanOutService {
    return this as unknown as WebhookFanOutService;
  }
}

export { InMemoryWebhookFanOutService, type AnnouncedEvent };
