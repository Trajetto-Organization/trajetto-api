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

  it("tells the WhatsApp story with the fate the delivery took", () => {
    const message = renderDeliveryOccurrenceWhatsApp(payload());

    expect(message).toContain("Entrega com insucesso");
    expect(message).toContain("Recusa da mercadoria");
    expect(message).toContain("Cliente recusou por avaria na caixa");
    expect(message).toContain("Fotos anexadas: *2*");
    expect(message).toContain("Insucesso");
  });

  it("omits what the report did not carry", () => {
    const message = renderDeliveryOccurrenceWhatsApp(
      payload({ description: null, photosCount: 0 }),
    );

    expect(message).not.toContain("Relato:");
    expect(message).not.toContain("Fotos anexadas");
  });
});
