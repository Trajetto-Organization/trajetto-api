import { describe, expect, it } from "vitest";

import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "@/shared/integration/webhook-signature";
import { buildPublicApiDocument } from "@/shared/integration/public-docs";

/**
 * Rotating a webhook secret without dropping events.
 *
 * The only way to change a leaked secret was to delete the endpoint — which
 * cascades its whole delivery history. A rotation now signs with both the new
 * secret and the one it replaced, for a grace period: the header carries two
 * `v1` values, the Stripe convention, and a receiver accepts the call if any
 * one verifies with the secret it holds. The receiver switches keys whenever
 * it is ready, and no event arrives unverifiable in between.
 */
const body = JSON.stringify({ id: "evt_1", topic: "delivery.created" });

describe("a signature during a rotation", () => {
  it("carries one v1 per secret, the new one first", () => {
    const signed = signWebhookPayload("whsec_new", body, new Date(), [
      "whsec_old",
    ]);

    expect(signed.header.match(/v1=/g)).toHaveLength(2);
    expect(signed.header.startsWith("t=")).toBe(true);
  });

  it("verifies with the new secret and with the old one", () => {
    const signed = signWebhookPayload("whsec_new", body, new Date(), [
      "whsec_old",
    ]);

    for (const secret of ["whsec_new", "whsec_old"]) {
      expect(
        verifyWebhookSignature({ secret, body, header: signed.header }),
        secret,
      ).toBe(true);
    }

    expect(
      verifyWebhookSignature({
        secret: "whsec_other",
        body,
        header: signed.header,
      }),
    ).toBe(false);
  });

  it("is explained where the integrator reads the verification recipe", () => {
    const description = String(buildPublicApiDocument({}).info?.description);

    // A receiver that keeps only the last `v1` rejects every call signed
    // during a rotation with the secret it still holds.
    expect(description).toMatch(/dois `v1`/);
    expect(description).toMatch(/qualquer um/);
  });

  it("is the plain single signature when nothing is being rotated", () => {
    const signed = signWebhookPayload("whsec_new", body);

    expect(signed.header.match(/v1=/g)).toHaveLength(1);
    expect(
      verifyWebhookSignature({
        secret: "whsec_new",
        body,
        header: signed.header,
      }),
    ).toBe(true);
  });
});
