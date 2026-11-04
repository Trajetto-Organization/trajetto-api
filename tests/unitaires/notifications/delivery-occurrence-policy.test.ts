import { describe, expect, it } from "vitest";

import {
  renderDeliveryOccurrenceInApp,
  renderDeliveryOccurrenceWhatsApp,
} from "@/shared/notifications/policies/delivery-occurrence-policy";

import type { DeliveryOccurrenceReportedPayload } from "@/shared/notifications/notification-types";

const payload = (
  overrides: Partial<DeliveryOccurrenceReportedPayload> = {},
): DeliveryOccurrenceReportedPayload => ({
  deliveryId: "delivery-1",
  businessId: "biz-1",
  recipientName: "Mercado Central",
  occurrenceTypeName: "Recusa da mercadoria",
  blocksDelivery: true,
  description: "Cliente recusou por avaria na caixa",
  photosCount: 2,
  reporterName: "João Motorista",
  deliveryStatusAfter: "Insucesso",
  ...overrides,
});

const ctx = { baseUrl: "https://app.trajetto.com" };

describe("delivery occurrence policy renders", () => {
  it("names the occurrence, the reporter and links to the delivery", () => {
    const rendered = renderDeliveryOccurrenceInApp(payload(), ctx);

    expect(rendered.title).toBe("Entrega com insucesso");
    expect(rendered.message).toContain("Recusa da mercadoria");
    expect(rendered.message).toContain("João Motorista");
    expect(rendered.message).toContain("Mercado Central");

    // The link drops the manager on the deliveries table already filtered
    // to the one delivery in question.
    expect(rendered.link).toBe(
      "https://app.trajetto.com/dashboard/deliveries?search=delivery-1&page=1",
    );
    expect(rendered.entityId).toBe("delivery-1");
  });

  // Plan of 02/11/2026 (B1): trajetto_entrega_insucesso.
  it("tells the WhatsApp story in its own template", () => {
    expect(renderDeliveryOccurrenceWhatsApp(payload())).toEqual({
      template: "trajetto_entrega_insucesso",
      parameters: [
        "Mercado Central",
        "Recusa da mercadoria",
        "João Motorista",
        "Cliente recusou por avaria na caixa",
        "2",
      ],
    });
  });

  it("leaves to the fallbacks what the report did not carry", () => {
    const rendered = renderDeliveryOccurrenceWhatsApp(
      payload({ description: "  \n ", photosCount: 0 }),
    );

    expect(rendered?.parameters[3]).toBeNull();
    expect(rendered?.parameters[4]).toBeNull();
  });

  /**
   * The approved text says "Insucesso": the topic is published only when a
   * blocking occurrence moved the delivery to FAILED. Anything else would
   * make Meta's fixed text false, so no WhatsApp goes out for it.
   */
  it("sends no WhatsApp unless the delivery ended as an insucesso", () => {
    expect(
      renderDeliveryOccurrenceWhatsApp(
        payload({ deliveryStatusAfter: "Em rota" }),
      ),
    ).toBeNull();
  });
});
