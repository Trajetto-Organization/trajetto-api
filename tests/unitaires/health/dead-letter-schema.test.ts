import { describe, expect, it } from "vitest";

import { healthResponses } from "@/routes/documentation/health-documentation";

/**
 * The dead letter lists deliveries to people outside the product too — the
 * carrier's own customers — and those have no user. The response schema
 * declared `userId` as a plain string, so the serializer threw on the first
 * such row and the whole listing answered 500: the one screen for finding
 * failed messages broke on the most common failure, a WhatsApp to a customer.
 */
describe("dead letter response", () => {
  it("accepts a delivery addressed to an external recipient", () => {
    const parsed = healthResponses.deadLetter.safeParse({
      data: [
        {
          id: "delivery-1",
          channel: "WHATSAPP",
          topic: "delivery.out_for_delivery",
          businessId: "business-1",
          userId: null,
          externalRecipientId: "external-1",
          attempts: 7,
          lastError: "(#131026) Message undeliverable",
          created_at: new Date().toISOString(),
          failedAt: new Date().toISOString(),
          eventId: "event-1",
          // Published by a worker: no request behind it.
          correlationId: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    expect(parsed.success).toBe(true);
  });
});
