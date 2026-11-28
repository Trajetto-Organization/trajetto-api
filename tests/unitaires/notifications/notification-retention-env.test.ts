import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * The bell's two retentions as environment variables (plano-escala F5-14).
 *
 * Missing or empty, they are the windows the nightly purge always had (90
 * days read, 180 unread): a deploy that never sets them changes nothing.
 * Under 30 days the boot refuses: a notification must outlive the delivery
 * that created it (30 days, with its event), or a re-sent IN_APP would find
 * no row to collide with and ring the bell twice.
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

describe("the bell's retention variables", () => {
  it("default to 90 days read and 180 unread, empty included", () => {
    for (const overrides of [
      {} as Record<string, string>,
      {
        NOTIFICATION_READ_RETENTION_DAYS: "",
        NOTIFICATION_UNREAD_RETENTION_DAYS: "",
      },
    ]) {
      const parsed = parse(overrides);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({
        NOTIFICATION_READ_RETENTION_DAYS: 90,
        NOTIFICATION_UNREAD_RETENTION_DAYS: 180,
      });
    }
  });

  it("take what is set, from 30 days up", () => {
    expect(
      parse({
        NOTIFICATION_READ_RETENTION_DAYS: "30",
        NOTIFICATION_UNREAD_RETENTION_DAYS: "365",
      }).data,
    ).toMatchObject({
      NOTIFICATION_READ_RETENTION_DAYS: 30,
      NOTIFICATION_UNREAD_RETENTION_DAYS: 365,
    });
  });

  it("refuse a window under 30 days, or one that is not a whole number", () => {
    for (const value of ["29", "0", "-1", "45.5", "noventa"]) {
      expect(
        parse({ NOTIFICATION_READ_RETENTION_DAYS: value }).success,
        value,
      ).toBe(false);
      expect(
        parse({ NOTIFICATION_UNREAD_RETENTION_DAYS: value }).success,
        value,
      ).toBe(false);
    }
  });
});
