import { describe, expect, it } from "vitest";

import { sign, verify } from "jsonwebtoken";

import { envSchema } from "@/schemas/env-schema";

/**
 * The keys every session is signed with.
 *
 * The schema took any string, so a deployment could boot with
 * `JWT_SECRET=trajetto` — or the `.env.example` placeholder — and nothing
 * would say so. HS256 with a short key falls to an offline dictionary from a
 * single captured token, and the attacker then mints an access token for any
 * user id, the MASTER's included. The same value for both keys made a refresh
 * token verify under the access key.
 */
const STRONG_ACCESS = "k".repeat(48);
const STRONG_REFRESH = "r".repeat(48);

const deployed = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: STRONG_ACCESS,
  JWT_SECRET_REFRESH_TOKEN: STRONG_REFRESH,
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "r2",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET_NAME: "b",
  R2_ACCESS_KEY_ID: "c",
  R2_SECRET_ACCESS_KEY: "d",
  RATE_LIMIT_TRUSTED_PROXY: "cloudflare",
};

function issuesFor(overrides: Record<string, string | undefined>): string[] {
  const result = envSchema.safeParse({ ...deployed, ...overrides });

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("JWT signing keys in a deployment", () => {
  it("boots with two long, different keys", () => {
    expect(issuesFor({})).toEqual([]);
  });

  it("refuses a short access key — the kind an offline dictionary breaks", () => {
    expect(issuesFor({ JWT_SECRET: "trajetto2026" })).toEqual(["JWT_SECRET"]);
  });

  it("refuses a short refresh key", () => {
    expect(issuesFor({ JWT_SECRET_REFRESH_TOKEN: "segredo" })).toEqual([
      "JWT_SECRET_REFRESH_TOKEN",
    ]);
  });

  it("refuses the .env.example placeholders, long as they are", () => {
    expect(
      issuesFor({
        JWT_SECRET: "GENERATE_A_LONG_RANDOM_SECRET_PLEASE_DO_IT_NOW",
        JWT_SECRET_REFRESH_TOKEN: "GENERATE_A_DIFFERENT_LONG_RANDOM_SECRET",
      }),
    ).toEqual(["JWT_SECRET", "JWT_SECRET_REFRESH_TOKEN"]);
  });

  it("refuses one key for both token kinds", () => {
    expect(issuesFor({ JWT_SECRET_REFRESH_TOKEN: STRONG_ACCESS })).toEqual([
      "JWT_SECRET_REFRESH_TOKEN",
    ]);
  });

  it("holds on staging too, which runs the production image", () => {
    expect(issuesFor({ APP_ENV: "staging", JWT_SECRET: "curto" })).toEqual([
      "JWT_SECRET",
    ]);
  });

  it("does not bind development or the load harness (APP_ENV=development)", () => {
    expect(
      issuesFor({
        NODE_ENV: "development",
        UPLOAD_STORAGE_TYPE: "local",
        JWT_SECRET: "a",
        JWT_SECRET_REFRESH_TOKEN: "b",
      }),
    ).toEqual([]);
    expect(
      issuesFor({
        APP_ENV: "development",
        JWT_SECRET: "a",
        JWT_SECRET_REFRESH_TOKEN: "b",
      }),
    ).toEqual([]);
  });

  it("is why one key for both was dangerous: a refresh token verified as access", () => {
    // The ensure-authenticated check on tokenType is the only other barrier;
    // with distinct keys the signature itself already refuses.
    const refresh = sign({ tokenType: "refresh" }, STRONG_REFRESH, {
      subject: "u",
    });

    expect(() => verify(refresh, STRONG_ACCESS)).toThrow();
    expect(() => verify(refresh, STRONG_REFRESH)).not.toThrow();
  });
});
