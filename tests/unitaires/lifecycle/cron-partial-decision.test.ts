import { describe, expect, it } from "vitest";

import {
  PartialRunError,
  throwIfPartial,
} from "@/shared/errors/partial-run-error";
import {
  catchUpDecision,
  inPartialWindow,
  partialWindowOn,
  type CatchUpFacts,
} from "@/shared/services/cron-catch-up-decision";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import {
  EXECUTION_LEASE_MS,
  parseUtcWindow,
} from "@/shared/services/cron-limits";

/**
 * When the hourly catch-up sweep runs a daily job (plano-escala F1-17).
 *
 * A purge that stopped on its budget with rows still due used to end
 * SUCCEEDED: nothing ran it again before the next night, and a growing
 * backlog read as a quiet night. It now ends FAILED with "[partial]", and
 * the sweep runs it again — but only after the 05:00 UTC backups and before
 * the morning (06:00–09:00 UTC by default), at most three times a day.
 * Without that cap the hourly sweep would re-run a purge that never
 * finishes through business hours, against the traffic. A failure that is
 * not partial keeps the old rule: no success in the window, run now.
 */

const POLICY = {
  window: parseUtcWindow("06:00-09:00")!,
  retriesPerDay: 3,
};

const PARTIAL = {
  status: "FAILED" as const,
  lastError: "[partial] parou no orçamento ou no teto com sobra em: x",
};

function facts(overrides: Partial<CatchUpFacts>): CatchUpFacts {
  return {
    now: new Date("2026-11-15T06:07:00.000Z"),
    lastRun: null,
    running: false,
    succeededInWindow: false,
    partialRetriesToday: 0,
    ...overrides,
  };
}

const at = (time: string) => new Date(`2026-11-15T${time}:00.000Z`);

describe("the catch-up decision", () => {
  it.each([
    // [case, facts, run, reason]
    ["never ran", {}, true, "missed"],
    [
      "failed, no success in the window",
      { lastRun: { status: "FAILED" as const, lastError: "boom" } },
      true,
      "missed",
    ],
    [
      "failed, but succeeded inside the window",
      {
        lastRun: { status: "FAILED" as const, lastError: "boom" },
        succeededInWindow: true,
      },
      false,
      "covered",
    ],
    [
      "succeeded inside the window",
      {
        lastRun: { status: "SUCCEEDED" as const, lastError: null },
        succeededInWindow: true,
      },
      false,
      "covered",
    ],
    [
      "a live run holds the lease",
      { lastRun: PARTIAL, running: true },
      false,
      "running",
    ],
    [
      "partial at 06:07",
      { lastRun: PARTIAL, now: at("06:07") },
      true,
      "partial",
    ],
    [
      "partial at 07:07",
      { lastRun: PARTIAL, now: at("07:07") },
      true,
      "partial",
    ],
    [
      "partial at 08:07",
      { lastRun: PARTIAL, now: at("08:07") },
      true,
      "partial",
    ],
    [
      "partial at 09:07, after the window",
      { lastRun: PARTIAL, now: at("09:07") },
      false,
      "partial_outside_window",
    ],
    [
      "partial at 14:07, in business hours",
      { lastRun: PARTIAL, now: at("14:07") },
      false,
      "partial_outside_window",
    ],
    [
      "partial at 04:07, before the backups",
      { lastRun: PARTIAL, now: at("04:07") },
      false,
      "partial_outside_window",
    ],
    [
      "partial with an older success inside the window",
      { lastRun: PARTIAL, succeededInWindow: true, now: at("06:07") },
      true,
      "partial",
    ],
    [
      "partial, two retries today",
      { lastRun: PARTIAL, partialRetriesToday: 2, now: at("08:07") },
      true,
      "partial",
    ],
    [
      "partial, three retries today",
      { lastRun: PARTIAL, partialRetriesToday: 3, now: at("08:37") },
      false,
      "partial_retries_exhausted",
    ],
  ] as const)("%s", (_case, overrides, run, reason) => {
    expect(catchUpDecision(facts(overrides), POLICY)).toEqual({ run, reason });
  });

  it("never retries a partial when the policy allows none", () => {
    const decision = catchUpDecision(facts({ lastRun: PARTIAL }), {
      ...POLICY,
      retriesPerDay: 0,
    });

    expect(decision).toEqual({
      run: false,
      reason: "partial_retries_exhausted",
    });
  });
});

describe("the partial window", () => {
  it("is [start, end) in UTC", () => {
    expect(inPartialWindow(at("05:59"), POLICY.window)).toBe(false);
    expect(inPartialWindow(at("06:00"), POLICY.window)).toBe(true);
    expect(inPartialWindow(at("08:59"), POLICY.window)).toBe(true);
    expect(inPartialWindow(at("09:00"), POLICY.window)).toBe(false);
  });

  it("is today's, as instants", () => {
    expect(partialWindowOn(at("07:30"), POLICY.window)).toEqual({
      start: at("06:00"),
      end: at("09:00"),
    });
  });

  it("reads HH:MM-HH:MM and refuses anything else", () => {
    expect(parseUtcWindow("06:00-09:00")).toEqual({
      startMinute: 360,
      endMinute: 540,
    });
    expect(parseUtcWindow("22:30-24:00")).toEqual({
      startMinute: 1350,
      endMinute: 1440,
    });

    const refused = [
      "09:00-06:00",
      "06:00-06:00",
      "6:00-9:00",
      "25:00-26:00",
      "06:60-07:00",
      "24:00-24:30",
      "",
    ];

    for (const bad of refused) {
      expect(parseUtcWindow(bad), bad).toBeNull();
    }
  });
});

describe("a partial run", () => {
  it("names what is left and is marked for the sweep", () => {
    expect(() =>
      throwIfPartial({
        notification: { stoppedEarly: true },
        activity: { stoppedEarly: false },
      }),
    ).toThrow(PartialRunError);

    try {
      throwIfPartial({ a: { stoppedEarly: true }, b: { stoppedEarly: true } });
    } catch (error) {
      expect((error as PartialRunError).pending).toEqual(["a", "b"]);
      expect((error as Error).message).toMatch(/^\[partial\] .*a, b$/);
    }
  });

  it("is not thrown when every part finished", () => {
    expect(() => throwIfPartial({ a: { stoppedEarly: false } })).not.toThrow();
  });
});

describe("the environment of the partial runs", () => {
  const BASE_ENV = {
    NODE_ENV: "test",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE_ENV, ...overrides }));

  it("defaults to five minutes, 06:00-09:00 and three retries", () => {
    const parsed = parse({
      CRON_PURGE_RUN_BUDGET_MS: "",
      CRON_PARTIAL_RETRY_WINDOW_UTC: "",
      CRON_PARTIAL_RETRIES_PER_DAY: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      CRON_PURGE_RUN_BUDGET_MS: 300_000,
      CRON_PARTIAL_RETRY_WINDOW_UTC: "06:00-09:00",
      CRON_PARTIAL_RETRIES_PER_DAY: 3,
    });
  });

  it("refuses a budget above half the lease", () => {
    // Past it, the sweep would take a live purge for a dead one.
    const accepts = (value: number) =>
      parse({ CRON_PURGE_RUN_BUDGET_MS: String(value) }).success;

    expect(accepts(EXECUTION_LEASE_MS / 2)).toBe(true);
    expect(accepts(1)).toBe(true);
    expect(accepts(EXECUTION_LEASE_MS / 2 + 1)).toBe(false);
    expect(accepts(0)).toBe(false);
  });

  it("refuses a window it cannot read", () => {
    const accepts = (value: string) =>
      parse({ CRON_PARTIAL_RETRY_WINDOW_UTC: value }).success;

    expect(accepts("07:00-08:30")).toBe(true);
    expect(accepts("09:00-06:00")).toBe(false);
    expect(accepts("manhã")).toBe(false);
  });
});
