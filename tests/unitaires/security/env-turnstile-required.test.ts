import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";

/**
 * The bot check of the public quote form in a deployment.
 *
 * The quote form is the one the API checks itself (login and password
 * recovery are checked by the web; the app's login is never challenged).
 * Without TURNSTILE_SECRET_KEY the API skipped it and only logged a warning
 * once — a variable forgotten in a deploy silently opened it to scripts.
 */
const deployed = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "k".repeat(48),
  JWT_SECRET_REFRESH_TOKEN: "r".repeat(48),
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

describe("TURNSTILE_SECRET_KEY", () => {
  it("is required in production", () => {
    expect(issuesFor({})).toEqual(["TURNSTILE_SECRET_KEY"]);
  });

  it("is required in staging, which runs the production image", () => {
    expect(issuesFor({ APP_ENV: "staging" })).toEqual(["TURNSTILE_SECRET_KEY"]);
  });

  it("counts an empty value as missing", () => {
    expect(issuesFor({ TURNSTILE_SECRET_KEY: "" })).toEqual([
      "TURNSTILE_SECRET_KEY",
    ]);
  });

  it("boots once it is set", () => {
    expect(issuesFor({ TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret" })).toEqual(
      [],
    );
  });

  it("stays optional for development and tests", () => {
    expect(
      issuesFor({
        NODE_ENV: "development",
        APP_ENV: "development",
        RATE_LIMIT_TRUSTED_PROXY: "none",
      }),
    ).toEqual([]);
  });
});
