import { KeyObject } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { sign, verify } from "jsonwebtoken";
import { describe, expect, it } from "vitest";

import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

const SECRET = "a".repeat(48);

/**
 * Every JWT verify passes a KeyObject, never the raw secret string.
 *
 * With a string, jsonwebtoken 9 runs `createPublicKey` on the secret before
 * every verify (and fails), then builds the secret key: measured under load in
 * the production image, that failed parse was ~7% of a replica's CPU, twice per
 * authenticated request (docs/desempenho/carga-2026-10.md).
 */
describe("hmacVerifyKey", () => {
  it("is a secret KeyObject, built once per secret", () => {
    const key = hmacVerifyKey(SECRET);

    expect(key).toBeInstanceOf(KeyObject);
    expect(key.type).toBe("secret");
    expect(hmacVerifyKey(SECRET)).toBe(key);
    expect(hmacVerifyKey(`${SECRET}b`)).not.toBe(key);
  });

  it("accepts exactly what the string secret accepted", () => {
    const token = sign({ sub: "user-1", tokenType: "access" }, SECRET, {
      expiresIn: "5m",
    });

    expect(verify(token, hmacVerifyKey(SECRET))).toMatchObject({
      sub: "user-1",
      tokenType: "access",
    });

    for (const algorithm of ["HS384", "HS512"] as const) {
      const other = sign({ sub: "user-2" }, SECRET, { algorithm });

      expect(verify(other, hmacVerifyKey(SECRET))).toMatchObject({
        sub: "user-2",
      });
    }
  });

  it("refuses what the string secret refused", () => {
    const forged = sign({ sub: "user-1" }, "b".repeat(48));
    const expired = sign(
      { sub: "user-1", exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
    );
    const unsigned = sign({ sub: "user-1" }, "", { algorithm: "none" });

    expect(() => verify(forged, hmacVerifyKey(SECRET))).toThrow(
      /invalid signature/,
    );
    expect(() => verify(expired, hmacVerifyKey(SECRET))).toThrow(/jwt expired/);
    expect(() => verify(unsigned, hmacVerifyKey(SECRET))).toThrow();
  });
});

describe("no verify in src takes the raw secret", () => {
  const root = resolve(__dirname, "../../../src");

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);

      return statSync(path).isDirectory()
        ? files(path)
        : path.endsWith(".ts")
          ? [path]
          : [];
    });

  it("every verify(…) names hmacVerifyKey", () => {
    const offenders = files(root).flatMap((file) => {
      const source = readFileSync(file, "utf8");

      if (!/from "jsonwebtoken"/.test(source)) return [];

      // The second argument of every verify( call, up to its closing comma.
      return [...source.matchAll(/\bverify\(\s*[\w.]+\s*,\s*([^,)]+)/g)]
        .map((match) => match[1].trim())
        .filter((secret) => !secret.startsWith("hmacVerifyKey("))
        .map((secret) => `${file.slice(root.length + 1)}: ${secret}`);
    });

    expect(offenders).toEqual([]);
  });
});
