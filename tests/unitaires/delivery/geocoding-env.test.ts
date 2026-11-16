import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import { geocodingRatesFromEnv } from "@/shared/delivery/geocoding/geocoding-gate";

/**
 * The geocoder's numbers from the environment (plano-escala F2-31). They
 * were constants sized for LocationIQ's free tier: a call a second, 50 in
 * any 60 s for the search, 40 for the background paths, 20 claims a
 * minute. The defaults keep exactly those, so a deploy that sets nothing
 * runs as before; a paid plan raises them in the Dokploy Environment
 * instead of in a release.
 */
const DEVELOPMENT = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string | undefined>) =>
  envSchema.safeParse(
    definedEnv(
      Object.fromEntries(
        Object.entries({ ...DEVELOPMENT, ...overrides }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    ),
  );

const issues = (overrides: Record<string, string | undefined>) => {
  const parsed = parse(overrides);

  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.path.join("."));
};

describe("the geocoder's rates, batch and run time", () => {
  it("default to the constants the free tier ran with", () => {
    const parsed = parse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      GEOCODING_CALLS_PER_SECOND: 1,
      GEOCODING_CALLS_PER_MINUTE: 50,
      GEOCODING_BACKGROUND_CALLS_PER_MINUTE: 40,
      DELIVERY_GEOCODING_BATCH_SIZE: 20,
      DELIVERY_GEOCODING_RUN_BUDGET_MS: 50_000,
    });
  });

  it("read an empty variable as unset", () => {
    const parsed = parse({
      GEOCODING_CALLS_PER_SECOND: "",
      DELIVERY_GEOCODING_BATCH_SIZE: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.GEOCODING_CALLS_PER_SECOND).toBe(1);
    expect(parsed.data?.DELIVERY_GEOCODING_BATCH_SIZE).toBe(20);
  });

  it("take a paid plan's rates", () => {
    // The Startup plan of the owner's table (decision D40).
    const parsed = parse({
      GEOCODING_CALLS_PER_SECOND: "17",
      GEOCODING_CALLS_PER_MINUTE: "1020",
      GEOCODING_BACKGROUND_CALLS_PER_MINUTE: "960",
      DELIVERY_GEOCODING_BATCH_SIZE: "50",
      DELIVERY_GEOCODING_RUN_BUDGET_MS: "55000",
    });

    expect(parsed.success).toBe(true);
    expect(geocodingRatesFromEnv(parsed.data!)).toEqual({
      perSecond: 17,
      perMinute: 1020,
      backgroundPerMinute: 960,
    });
  });

  it("refuse a background ceiling above the search's: the minute's tail is the search's", () => {
    expect(
      issues({
        GEOCODING_CALLS_PER_MINUTE: "50",
        GEOCODING_BACKGROUND_CALLS_PER_MINUTE: "51",
      }),
    ).toEqual(["GEOCODING_BACKGROUND_CALLS_PER_MINUTE"]);
  });

  it("refuse a run longer than the minute's job may take, and a rate of zero", () => {
    expect(issues({ DELIVERY_GEOCODING_RUN_BUDGET_MS: "60000" })).toEqual([
      "DELIVERY_GEOCODING_RUN_BUDGET_MS",
    ]);
    expect(issues({ GEOCODING_CALLS_PER_SECOND: "0" })).toEqual([
      "GEOCODING_CALLS_PER_SECOND",
    ]);
    expect(issues({ DELIVERY_GEOCODING_BATCH_SIZE: "0" })).toEqual([
      "DELIVERY_GEOCODING_BATCH_SIZE",
    ]);
  });
});
