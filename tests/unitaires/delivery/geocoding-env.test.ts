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

/**
 * Plano-escala F2-32 (decision D40): the proof's reverse lookup has a
 * second and a day of its own, and once the owner writes the plan down
 * (LOCATIONIQ_RATE_PER_SECOND, LOCATIONIQ_DAILY_QUOTA) the boot refuses
 * rates or budgets that pass 90% of it — the margin that keeps a burst or
 * a late day away from the 429 that holds every path until midnight.
 */
describe("the geocoder's share of the provider's plan", () => {
  /** The owner's table, decision D40. */
  const DEVELOPER = {
    LOCATIONIQ_RATE_PER_SECOND: "20",
    LOCATIONIQ_DAILY_QUOTA: "25000",
    GEOCODING_CALLS_PER_SECOND: "16",
    GEOCODING_CALLS_PER_MINUTE: "960",
    GEOCODING_BACKGROUND_CALLS_PER_MINUTE: "900",
    GEOCODING_PROOF_RESERVED_PER_SECOND: "2",
    DELIVERY_GEOCODING_DAILY_BUDGET: "17000",
    ADDRESS_SEARCH_DAILY_BUDGET: "2500",
    PROOF_REVERSE_DAILY_BUDGET: "3000",
  };

  const STARTUP = {
    ...DEVELOPER,
    LOCATIONIQ_RATE_PER_SECOND: "22",
    LOCATIONIQ_DAILY_QUOTA: "60000",
    GEOCODING_CALLS_PER_SECOND: "17",
    GEOCODING_CALLS_PER_MINUTE: "1020",
    GEOCODING_BACKGROUND_CALLS_PER_MINUTE: "960",
    DELIVERY_GEOCODING_DAILY_BUDGET: "45000",
    ADDRESS_SEARCH_DAILY_BUDGET: "4000",
    PROOF_REVERSE_DAILY_BUDGET: "5000",
  };

  it("defaults to one call a second and 1,500 a day for the proof, and checks no plan", () => {
    const parsed = parse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      GEOCODING_PROOF_RESERVED_PER_SECOND: 1,
      PROOF_REVERSE_DAILY_BUDGET: 1500,
    });
    expect(parsed.data?.LOCATIONIQ_RATE_PER_SECOND).toBeUndefined();
    expect(parsed.data?.LOCATIONIQ_DAILY_QUOTA).toBeUndefined();
  });

  it("takes the free tier's defaults within 90% of its day", () => {
    // Job 2,000 + search 1,000 + proof 1,500 = 4,500 of 5,000.
    expect(issues({ LOCATIONIQ_DAILY_QUOTA: "5000" })).toEqual([]);
  });

  it("takes the Developer and the Startup plans of the owner's table, at 90% exactly", () => {
    expect(issues(DEVELOPER)).toEqual([]);
    expect(issues(STARTUP)).toEqual([]);
  });

  it("refuses rates a second above 90% of the plan's", () => {
    expect(
      issues({ ...DEVELOPER, GEOCODING_PROOF_RESERVED_PER_SECOND: "3" }),
    ).toEqual(["LOCATIONIQ_RATE_PER_SECOND"]);
    expect(issues({ ...DEVELOPER, GEOCODING_CALLS_PER_SECOND: "17" })).toEqual([
      "LOCATIONIQ_RATE_PER_SECOND",
    ]);
  });

  it("refuses budgets a day above 90% of the plan's quota, the proof's included", () => {
    expect(
      issues({ ...DEVELOPER, PROOF_REVERSE_DAILY_BUDGET: "3001" }),
    ).toEqual(["LOCATIONIQ_DAILY_QUOTA"]);
    expect(issues({ ...DEVELOPER, LOCATIONIQ_DAILY_QUOTA: "24999" })).toEqual([
      "LOCATIONIQ_DAILY_QUOTA",
    ]);
  });

  it("says which variables and what the most is", () => {
    const parsed = parse({ ...DEVELOPER, ADDRESS_SEARCH_DAILY_BUDGET: "2600" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toMatch(
      /PROOF_REVERSE_DAILY_BUDGET = 22600 .* no máximo 22500 por dia/,
    );
  });

  it("switches the proof's lookup off with a budget of 0, and never takes a reserve of 0", () => {
    expect(issues({ PROOF_REVERSE_DAILY_BUDGET: "0" })).toEqual([]);
    expect(issues({ GEOCODING_PROOF_RESERVED_PER_SECOND: "0" })).toEqual([
      "GEOCODING_PROOF_RESERVED_PER_SECOND",
    ]);
  });
});

/**
 * Plano-escala F2-33: how long the provider's NOT_FOUND or COARSE about a
 * door stands for the company's other deliveries there. A month by
 * default; 0 asks the provider for each delivery, as before.
 */
describe("the verdict's window", () => {
  it("defaults to 30 days, takes 0 to switch it off, and refuses more than a year", () => {
    expect(parse({}).data?.GEOCODING_VERDICT_REUSE_DAYS).toBe(30);
    expect(parse({ GEOCODING_VERDICT_REUSE_DAYS: "0" }).data).toMatchObject({
      GEOCODING_VERDICT_REUSE_DAYS: 0,
    });
    expect(issues({ GEOCODING_VERDICT_REUSE_DAYS: "366" })).toEqual([
      "GEOCODING_VERDICT_REUSE_DAYS",
    ]);
  });
});
