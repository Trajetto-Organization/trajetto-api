import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * Which deployment the API is running in, apart from NODE_ENV.
 *
 * The image is built with NODE_ENV=production inlined, so staging runs it
 * too: before APP_ENV nothing in the code could tell staging from production
 * (zero occurrences of "staging"), and a staging booted with NODE_ENV
 * development would have skipped every production guard it exists to prove.
 */
const production = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "r2",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET_NAME: "b",
  R2_ACCESS_KEY_ID: "c",
  R2_SECRET_ACCESS_KEY: "d",
  RATE_LIMIT_TRUSTED_PROXY: "cloudflare",
};

const development = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (source: Record<string, string>) =>
  envSchema.safeParse(definedEnv(source));

describe("APP_ENV", () => {
  it("names staging on the production image", () => {
    const parsed = parse({ ...production, APP_ENV: "staging" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.APP_ENV).toBe("staging");
  });

  it("keeps staging under every production guard", () => {
    const parsed = parse({
      ...production,
      APP_ENV: "staging",
      UPLOAD_STORAGE_TYPE: "local",
    });

    expect(parsed.success).toBe(false);
    expect(
      !parsed.success &&
        parsed.error.issues.map((issue) => issue.path.join(".")),
    ).toContain("UPLOAD_STORAGE_TYPE");
  });

  it.each(["staging", "production"])(
    "refuses %s outside NODE_ENV=production, which would skip those guards",
    (appEnv) => {
      const parsed = parse({ ...development, APP_ENV: appEnv });

      expect(parsed.success).toBe(false);
      expect(
        !parsed.success &&
          parsed.error.issues.map((issue) => issue.path.join(".")),
      ).toEqual(["APP_ENV"]);
    },
  );

  it("follows NODE_ENV when unset or empty, so an older stack still boots as production", () => {
    for (const source of [production, { ...production, APP_ENV: "" }]) {
      const parsed = parse(source);

      expect(parsed.success && parsed.data.APP_ENV).toBe("production");
    }

    for (const nodeEnv of ["development", "test"]) {
      const parsed = parse({ ...development, NODE_ENV: nodeEnv });

      expect(parsed.success && parsed.data.APP_ENV).toBe("development");
    }
  });

  it("accepts only the three deployments", () => {
    expect(parse({ ...production, APP_ENV: "homolog" }).success).toBe(false);
    expect(parse({ ...production, APP_ENV: "preview" }).success).toBe(false);
  });

  it("lets a local run of the production image call itself development", () => {
    // The load harness runs the real image on a laptop: neither staging nor
    // production, and nothing there should be mistaken for either.
    const parsed = parse({
      ...production,
      APP_ENV: "development",
      RATE_LIMIT_TRUSTED_PROXY: "xff",
    });

    expect(parsed.success && parsed.data.APP_ENV).toBe("development");
  });
});
