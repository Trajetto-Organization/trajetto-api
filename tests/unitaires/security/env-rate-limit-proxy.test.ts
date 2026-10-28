import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";

/**
 * Production must say which proxy it sits behind.
 *
 * The variable was missing from the production compose, the default `none`
 * went in silently, and behind Traefik every anonymous client shared
 * Traefik's address: one bucket of eight logins a minute for the whole
 * product, and the same for two-factor, password recovery and refresh. The
 * boot now refuses to start without an explicit answer.
 */
const production = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "r2",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET_NAME: "b",
  R2_ACCESS_KEY_ID: "c",
  R2_SECRET_ACCESS_KEY: "d",
};

function issuesFor(overrides: Record<string, string | undefined>): string[] {
  const result = envSchema.safeParse({ ...production, ...overrides });

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("RATE_LIMIT_TRUSTED_PROXY in production", () => {
  it("refuses to boot when it is missing", () => {
    expect(issuesFor({})).toContain("RATE_LIMIT_TRUSTED_PROXY");
  });

  it("treats an empty value — a compose passing an unset variable — as missing", () => {
    expect(issuesFor({ RATE_LIMIT_TRUSTED_PROXY: "" })).toContain(
      "RATE_LIMIT_TRUSTED_PROXY",
    );
  });

  it("boots with an explicit answer", () => {
    for (const mode of ["xff", "cloudflare", "none"]) {
      expect(issuesFor({ RATE_LIMIT_TRUSTED_PROXY: mode })).toEqual([]);
    }
  });

  it("does not demand it outside production", () => {
    expect(
      issuesFor({ NODE_ENV: "development", UPLOAD_STORAGE_TYPE: "local" }),
    ).toEqual([]);
  });
});

describe("RATE_LIMIT_FORWARDER_SECRET", () => {
  it("is optional, and an empty value counts as absent", () => {
    expect(
      issuesFor({
        RATE_LIMIT_TRUSTED_PROXY: "xff",
        RATE_LIMIT_FORWARDER_SECRET: "",
      }),
    ).toEqual([]);
  });

  it("refuses a secret too short to be one", () => {
    expect(
      issuesFor({
        RATE_LIMIT_TRUSTED_PROXY: "xff",
        RATE_LIMIT_FORWARDER_SECRET: "curto",
      }),
    ).toContain("RATE_LIMIT_FORWARDER_SECRET");
  });
});
