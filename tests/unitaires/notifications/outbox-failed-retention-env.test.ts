import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * How long the dead letters keep a failure (plano-escala F5-10).
 *
 * Missing or empty, OUTBOX_FAILED_RETENTION_DAYS is the 90 days the nightly
 * purge always kept a failure: a deploy that never sets it changes
 * nothing. At 30 or less the boot refuses: a FAILED event leaves the queue
 * table at 30 days, and would expire the night it is copied.
 */
const BASE = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string>) =>
  envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

describe("OUTBOX_FAILED_RETENTION_DAYS", () => {
  it("defaults to the 90 days the purge always kept, empty included", () => {
    for (const overrides of [
      {} as Record<string, string>,
      { OUTBOX_FAILED_RETENTION_DAYS: "" },
    ]) {
      expect(parse(overrides).data).toMatchObject({
        OUTBOX_FAILED_RETENTION_DAYS: 90,
      });
    }
  });

  it("takes what is set over 30 days", () => {
    expect(parse({ OUTBOX_FAILED_RETENTION_DAYS: "31" }).data).toMatchObject({
      OUTBOX_FAILED_RETENTION_DAYS: 31,
    });
  });

  it("refuses 30 days or less, or what is not a whole number", () => {
    for (const value of ["30", "1", "0", "90.5", "noventa"]) {
      expect(
        parse({ OUTBOX_FAILED_RETENTION_DAYS: value }).success,
        value,
      ).toBe(false);
    }
  });
});
