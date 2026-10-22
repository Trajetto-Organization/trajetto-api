import { hash } from "bcrypt";
import { describe, expect, it } from "vitest";

import {
  hashOneTimeCode,
  verifyOneTimeCode,
} from "@/shared/security/one-time-code";

/**
 * How a six-digit two-factor code is kept.
 *
 * It was a cost-10 bcrypt: ~55 ms of libuv threadpool per code issued and per
 * guess, and a timing signal on the anonymous resend route. The code lives 15
 * minutes and survives five guesses — those limits are what stop guessing.
 * What is left for the hash is a leaked table, and for that a key the table
 * does not hold beats any work factor: an unkeyed hash of 10^6 values is
 * reversed instantly, and so is a cost-10 bcrypt of them, given a few CPU
 * hours. An HMAC under a server-side key is not reversible without the key.
 */
describe("a code issued now", () => {
  it("verifies with the code, and only with the code", async () => {
    const stored = hashOneTimeCode("482910");

    expect(await verifyOneTimeCode("482910", stored)).toBe(true);
    expect(await verifyOneTimeCode("482911", stored)).toBe(false);
    expect(await verifyOneTimeCode("", stored)).toBe(false);
  });

  it("is not stored as the code, nor as a bare unkeyed digest of it", async () => {
    const { createHash } = await import("node:crypto");
    const stored = hashOneTimeCode("482910");

    expect(stored).not.toContain("482910");
    expect(stored).not.toContain(
      createHash("sha256").update("482910").digest("hex"),
    );
  });

  it("is not a bcrypt hash, so issuing it does not touch the threadpool", () => {
    expect(hashOneTimeCode("482910").startsWith("$2")).toBe(false);
  });

  it("is stored differently each time, so two accounts with the same code never collide", async () => {
    // two_factor_token.token is UNIQUE: a deterministic value made the
    // second account to draw a code already held by another row fail its
    // login with a 500 (tests/E2E/two-factor-code-collision).
    const first = hashOneTimeCode("482910");
    const second = hashOneTimeCode("482910");

    expect(second).not.toBe(first);
    expect(await verifyOneTimeCode("482910", first)).toBe(true);
    expect(await verifyOneTimeCode("482910", second)).toBe(true);
  });

  it("does not verify when the stored value was tampered with", async () => {
    const stored = hashOneTimeCode("482910");
    const [prefix, salt, mac] = stored.split(":");

    expect(await verifyOneTimeCode("482910", `${prefix}:${mac}`)).toBe(false);
    expect(
      await verifyOneTimeCode(
        "482910",
        `${prefix}:${"0".repeat(salt.length)}:${mac}`,
      ),
    ).toBe(false);
  });
});

describe("a code issued before this deploy", () => {
  it("still verifies: codes live 15 minutes and some are in flight", async () => {
    const legacy = await hash("135790", 4);

    expect(await verifyOneTimeCode("135790", legacy)).toBe(true);
    expect(await verifyOneTimeCode("135791", legacy)).toBe(false);
  });
});

describe("a stored value that is neither", () => {
  it("never verifies", async () => {
    expect(await verifyOneTimeCode("123456", "123456")).toBe(false);
    expect(await verifyOneTimeCode("123456", "")).toBe(false);
  });
});
