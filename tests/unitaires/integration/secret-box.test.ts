import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SEALED_PREFIX,
  isSealed,
  openHeaders,
  openSecret,
  sealHeaders,
  sealSecret,
} from "@/shared/integration/secret-box";

/**
 * What a database dump reveals about a customer's webhooks.
 *
 * The signing secret and the headers a customer configured (usually their
 * gateway's Authorization) were stored in clear: a leaked backup let anybody
 * forge webhooks to every customer and call their systems with their own
 * credentials. They are sealed now, with a key that lives outside the
 * database — and the rows written before that still read.
 */
const key = randomBytes(32);
const otherKey = randomBytes(32);

describe("a sealed secret", () => {
  it("round-trips, and never contains the secret", () => {
    const sealed = sealSecret("whsec_abc123", key);

    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed).not.toContain("whsec_abc123");
    expect(isSealed(sealed)).toBe(true);

    expect(openSecret(sealed, key)).toBe("whsec_abc123");
  });

  it("is different every time, so equal secrets do not look equal", () => {
    expect(sealSecret("whsec_abc123", key)).not.toBe(
      sealSecret("whsec_abc123", key),
    );
  });

  it("refuses a tampered or foreign ciphertext instead of returning garbage", () => {
    const sealed = sealSecret("whsec_abc123", key);
    const parts = sealed.split(":");
    const body = Buffer.from(parts[parts.length - 1], "base64");

    body[0] ^= 0xff;
    parts[parts.length - 1] = body.toString("base64");

    expect(() => openSecret(parts.join(":"), key)).toThrow();
    expect(() => openSecret(sealed, otherKey)).toThrow();
  });

  it("reads a row written before sealing existed", () => {
    expect(isSealed("whsec_legacy")).toBe(false);
    expect(openSecret("whsec_legacy", key)).toBe("whsec_legacy");
  });
});

describe("sealed headers", () => {
  it("round-trips, and hides the credential", () => {
    const headers = { Authorization: "Bearer segredo-do-cliente" };
    const sealed = sealHeaders(headers, key);

    expect(JSON.stringify(sealed)).not.toContain("segredo-do-cliente");
    expect(openHeaders(sealed, key)).toEqual(headers);
  });

  it("keeps null as null, and reads the plain object of an older row", () => {
    expect(sealHeaders(null, key)).toBeNull();
    expect(openHeaders(null, key)).toBeNull();

    expect(openHeaders({ "X-Api-Key": "abc" }, key)).toEqual({
      "X-Api-Key": "abc",
    });
  });
});
