import { describe, expect, it } from "vitest";

import { announceOccurrenceEffect } from "@/modules/delivery/usecases/report-delivery-occurrence/occurrence-effect";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { WEBHOOK_PAYLOAD_SCHEMAS } from "@/shared/integration/webhook-payload-schemas";

import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";

/**
 * `occurrence_code` on the occurrence.reported webhook (plan of 02/11/2026,
 * L8): the company's ERP code for the type, sent beside the name — which the
 * company can rename — on BOTH paths that apply an occurrence (the report and
 * the tower's approval share this effect), null when the type has none, and
 * published in the payload schema an integrator codes against.
 */
const BUSINESS = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const DELIVERY = "0192f7f0-5c1e-7a3b-9d2e-4f6a8b0c1d2e";

async function announced(occurrenceTypeCode: string | null) {
  const webhooks = new InMemoryWebhookFanOutService();

  await announceOccurrenceEffect(
    {
      delivery: {} as never,
      route: {} as never,
      outbox: {} as never,
      webhooks: webhooks.asService(),
    },
    {
      tx: {} as never,
      businessId: BUSINESS,
      deliveryId: DELIVERY,
      delivery: {
        id: DELIVERY,
        businessId: BUSINESS,
        recipient_name: "Mercado",
        city: "Campinas",
        uf: "SP",
        status: "IN_TRANSIT",
      } as Delivery,
      // Informative: nothing changes, so only the webhook is announced.
      previousStatus: "IN_TRANSIT",
      nextStatus: "IN_TRANSIT",
      occurrenceTypeName: "Cliente ausente",
      occurrenceTypeCode,
      blocksDelivery: false,
      description: null,
      photosCount: 0,
      actorId: "user-1",
      reporterName: "João",
      at: new Date("2026-11-03T12:00:00.000Z"),
    },
  );

  return webhooks.forTopic("occurrence.reported")[0]?.payload;
}

describe("occurrence_code on occurrence.reported", () => {
  it("carries the type's ERP code beside its name", async () => {
    expect(await announced("AUS-01")).toMatchObject({
      occurrence_type: "Cliente ausente",
      occurrence_code: "AUS-01",
    });
  });

  it("is null, never absent, for a type without a code", async () => {
    const payload = await announced(null);

    expect(payload).toHaveProperty("occurrence_code", null);
  });

  it("is published in the occurrence payload schema", () => {
    const schema = WEBHOOK_PAYLOAD_SCHEMAS.WebhookOccurrenceData as {
      properties: Record<string, { nullable?: boolean }>;
    };

    expect(schema.properties.occurrence_code?.nullable).toBe(true);
  });
});
