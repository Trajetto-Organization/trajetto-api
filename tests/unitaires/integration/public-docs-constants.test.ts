import { describe, expect, it, vi } from "vitest";

/**
 * The signature numbers in the public text follow the constants the signer
 * and the rotation use, instead of a copy typed next to them.
 *
 * The introduction said "300 s" and "24 horas" by hand, and the samples
 * defaulted to a literal 300, while SIGNATURE_TOLERANCE_SECONDS and the
 * rotation grace live in webhook-signature.ts: changing either left the
 * reference teaching the old value. The module is mocked with other values
 * to prove the text reads them.
 */
vi.mock("@/shared/integration/webhook-signature", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/integration/webhook-signature")
  >()),
  SIGNATURE_TOLERANCE_SECONDS: 120,
  WEBHOOK_SECRET_ROTATION_GRACE_MS: 48 * 60 * 60 * 1000,
}));

import {
  NODE_VERIFICATION_SAMPLE,
  PHP_VERIFICATION_SAMPLE,
  PYTHON_VERIFICATION_SAMPLE,
  buildPublicApiDocument,
} from "@/shared/integration/public-docs";

const document = buildPublicApiDocument({}, {});
const description = String(
  (document.info as { description: string }).description,
);

describe("the signature tolerance in the public reference", () => {
  it("is the one the constant sets, in the text and in every sample", () => {
    expect(description).toContain("mais de 120 s de diferença");
    expect(description).not.toContain("300 s");

    expect(NODE_VERIFICATION_SAMPLE).toContain("toleranceSeconds = 120");
    expect(PHP_VERIFICATION_SAMPLE).toContain("$tolerance = 120");
    expect(PYTHON_VERIFICATION_SAMPLE).toContain("tolerance: int = 120");
  });

  it("is the one the guides read from the document", () => {
    const webhooks = document["x-trajetto-webhooks"] as {
      signature: { tolerance_seconds: number; rotation_grace_hours: number };
    };

    expect(webhooks.signature.tolerance_seconds).toBe(120);
    expect(webhooks.signature.rotation_grace_hours).toBe(48);
  });
});

describe("the rotation grace in the public reference", () => {
  it("is the one the constant sets", () => {
    expect(description).toMatch(/durante as 48 horas seguintes à troca/);
    expect(description).not.toContain("24 horas");
  });
});
