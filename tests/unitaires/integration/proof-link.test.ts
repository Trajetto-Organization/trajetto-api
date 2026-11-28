import { describe, expect, it } from "vitest";

import {
  PROOF_LINK_PATH,
  proofLinkSigns,
  proofLinkToken,
  proofLinkUrl,
  readProofLinkToken,
} from "@/shared/integration/proof-link";
import { deliveryEventPayload } from "@/shared/integration/announce";
import { toPublicDelivery } from "@/shared/integration/public-shapes";

/**
 * The bearer link to a delivery's receipt (plan of 02/11/2026, L7, ADR 0009):
 * what an integrator gets in `proof_url`. The token IS the authorisation, so
 * it has to be unguessable, bound to the delivery AND to its company, the
 * same every time it is printed (an ERP that diffs payloads must not see it
 * change), and only ever handed out for a delivery that ended.
 */
const DELIVERY = "0192f7f0-5c1e-7a3b-9d2e-4f6a8b0c1d2e";
const BUSINESS = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const OTHER_BUSINESS = "0192f7e0-1a2b-7c3d-8e4f-5a6b7c8d9e10";

describe("the proof link token", () => {
  it("is stable for a delivery and names it, with an unguessable signature", () => {
    const token = proofLinkToken(DELIVERY, BUSINESS);

    expect(proofLinkToken(DELIVERY, BUSINESS)).toBe(token);

    const read = readProofLinkToken(token);

    expect(read?.deliveryId).toBe(DELIVERY);
    // 256 bits, base64url: no padding, nothing a URL must escape.
    expect(read?.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("verifies only for the delivery's own company", () => {
    const read = readProofLinkToken(proofLinkToken(DELIVERY, BUSINESS))!;

    expect(proofLinkSigns(read.signature, DELIVERY, BUSINESS)).toBe(true);
    // The same id under another tenant is not the same capability.
    expect(proofLinkSigns(read.signature, DELIVERY, OTHER_BUSINESS)).toBe(
      false,
    );
  });

  it("refuses a signature one character off, and anything not shaped like a token", () => {
    const token = proofLinkToken(DELIVERY, BUSINESS);
    const read = readProofLinkToken(token)!;
    const flipped =
      read.signature.slice(0, -1) + (read.signature.endsWith("A") ? "B" : "A");

    expect(proofLinkSigns(flipped, DELIVERY, BUSINESS)).toBe(false);

    for (const garbage of [
      "",
      DELIVERY,
      `${DELIVERY}.`,
      `nao-e-uuid.${read.signature}`,
      `${DELIVERY}.${read.signature}.extra`,
      `${DELIVERY}.curta`,
    ]) {
      expect(readProofLinkToken(garbage), garbage).toBeNull();
    }
  });

  it("is published under the API's public prefix", () => {
    expect(proofLinkUrl(DELIVERY, BUSINESS)).toMatch(
      new RegExp(
        `^https?://[^/]+${PROOF_LINK_PATH}/${DELIVERY}\\.[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(PROOF_LINK_PATH).toBe("/public/delivery-proof");
  });
});

describe("where proof_url appears", () => {
  const settledDelivery = (status: string) => ({
    id: DELIVERY,
    businessId: BUSINESS,
    code: "PED-1",
    invoice_key: null,
    invoice_number: null,
    status,
    recipient_name: "Mercado",
    recipient_document: null,
    street: "Rua",
    address_number: null,
    complement: null,
    neighborhood: null,
    city: "Campinas",
    uf: "SP",
    cep: null,
    scheduled_date: null,
    delivered_at: null,
    received_by: null,
    created_at: new Date("2026-09-23T18:42:10.000Z"),
    updated_at: new Date("2026-09-24T08:15:32.000Z"),
  });

  it("is set on the webhook of a delivery that ended, and null on the others", () => {
    for (const status of ["DELIVERED", "FAILED"]) {
      expect(
        deliveryEventPayload(settledDelivery(status)).proof_url,
        status,
      ).toBe(proofLinkUrl(DELIVERY, BUSINESS));
    }

    for (const status of ["PENDING", "IN_TRANSIT", "CANCELLED"]) {
      expect(
        deliveryEventPayload(settledDelivery(status)).proof_url,
        status,
      ).toBeNull();
    }
  });

  it("is set on the public read of a delivery that ended, and null on the others", () => {
    expect(toPublicDelivery(settledDelivery("DELIVERED")).proof_url).toBe(
      proofLinkUrl(DELIVERY, BUSINESS),
    );
    expect(toPublicDelivery(settledDelivery("FAILED")).proof_url).toBe(
      proofLinkUrl(DELIVERY, BUSINESS),
    );
    expect(toPublicDelivery(settledDelivery("IN_TRANSIT")).proof_url).toBe(
      null,
    );
  });
});
