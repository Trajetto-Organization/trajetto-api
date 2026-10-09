import { describe, expect, it } from "vitest";

import {
  deliveryAssignedPayload,
  deliveryEventPayload,
} from "@/shared/integration/announce";

import { buildPublicApiDocument } from "@/shared/integration/public-docs";

/**
 * The time of the fact on a webhook, as built and as published (MOB-08).
 *
 * The envelope's `created_at` is when the event was generated — the fan-out,
 * which for a proof the app queued in a dead zone is the UPLOAD, hours after
 * the receipt was signed. An ERP that dated the delivery by it recorded
 * "entregue às 13:40" for a receipt signed at 10:05. The document events
 * that describe something the driver did carry the fact's own time in
 * `data.occurred_at`; everything else carries null, additively.
 */
const document = buildPublicApiDocument({});

const schemas = (
  document.components as {
    schemas: Record<
      string,
      { properties?: Record<string, { description?: string; type?: unknown }> }
    >;
  }
).schemas;

describe("the payload builder", () => {
  it("writes the time of the fact as an ISO instant", () => {
    const provenAt = new Date("2026-09-24T10:05:00.000Z");

    expect(deliveryEventPayload({ id: "x" }, provenAt).occurred_at).toBe(
      "2026-09-24T10:05:00.000Z",
    );
  });

  it("writes null when the event is not a fact from the field", () => {
    // Additive: the key is always there, so a subscriber's parser meets one
    // shape on every document event.
    expect(deliveryEventPayload({ id: "x" })).toHaveProperty("occurred_at", null);

    expect(
      deliveryAssignedPayload({ id: "x" }, { id: "r", code: 1, driverId: "d" }),
    ).toHaveProperty("occurred_at", null);
  });
});

describe("the public reference", () => {
  it("documents occurred_at on every document shape, nullable, apart from created_at", () => {
    for (const shape of [
      "WebhookDocumentData",
      "WebhookAssignmentData",
      "WebhookOccurrenceData",
    ]) {
      const field = schemas[shape]?.properties?.occurred_at;

      expect(field, shape).toBeDefined();
      // OpenAPI 3.1 (the public document's version): nullable is a null type.
      expect(field?.type, shape).toEqual(["string", "null"]);
      expect(field?.description ?? "", shape).toMatch(/created_at/);
    }
  });

  it("tells the integrator which date to keep, in the introduction", () => {
    const description = String(document.info?.description);

    expect(description).toContain("occurred_at");
    expect(description).toContain("proof.registered");
    expect(description).toContain("delivery.delivered");
  });
});
