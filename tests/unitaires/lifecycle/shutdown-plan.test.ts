import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  DEFAULT_STOP_GRACE_PERIOD_MS,
  MAX_STOP_GRACE_PERIOD_MS,
  MIN_STOP_GRACE_PERIOD_MS,
  importDrainMs,
  planShutdown,
  shutdownPlanFor,
  shutdownPlanProblems,
  type ShutdownPlan,
} from "@/shared/lifecycle/shutdown-plan";

/**
 * Every deadline of the graceful shutdown comes from the stop grace period
 * the Swarm really gives the task (plano-escala F1-14).
 *
 * The sequence ran on constants sized for a 40 s grace nobody had confirmed
 * on the service: with Docker's default of 10 s, the 12 s drain alone
 * outlived it, and a deploy SIGKILLed the replica mid-drain — the import
 * hand-backs and the workers' last records never written, the in-flight
 * requests cut. Now the grace is stated (STOP_GRACE_PERIOD_MS, 10 s when
 * absent) and the plan derived from it always ends before the SIGKILL; an
 * override that would not is refused at boot.
 */

/** When the workers are done, counted from SIGTERM (server.ts's order). */
function workersEndAt(plan: ShutdownPlan): number {
  return Math.max(plan.drainMs, importDrainMs(plan)) + plan.workersMs;
}

/** The minimum a development boot needs. */
const BASE_ENV = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string>) =>
  envSchema.safeParse({ ...BASE_ENV, ...overrides });

describe("planShutdown", () => {
  it("keeps today's deadlines with the 40 s grace the Application is meant to have", () => {
    expect(planShutdown(40_000)).toEqual({
      graceMs: 40_000,
      timeoutMs: 35_000,
      drainMs: 12_000,
      importGraceMs: 15_000,
      importStopGraceMs: 5_000,
      importHandBackMs: 2_000,
      workersMs: 12_000,
    });
  });

  it("ends in under 9 s with Docker's default grace, the one assumed without the variable", () => {
    expect(DEFAULT_STOP_GRACE_PERIOD_MS).toBe(10_000);

    const plan = planShutdown(DEFAULT_STOP_GRACE_PERIOD_MS);

    expect(plan.timeoutMs).toBeLessThan(9_000);
    expect(workersEndAt(plan)).toBeLessThanOrEqual(plan.timeoutMs);
  });

  it("fits inside the grace for every grace it accepts", () => {
    const graces: number[] = [];

    for (
      let grace = MIN_STOP_GRACE_PERIOD_MS;
      grace <= MAX_STOP_GRACE_PERIOD_MS;
      grace += 250
    ) {
      graces.push(grace);
    }

    // The odd values a person types, around both ends of the clamp.
    graces.push(7_001, 7_999, 8_001, 9_999, 39_999, 40_001, 299_999);

    for (const grace of graces) {
      const plan = planShutdown(grace);

      // The watchdog exits on its own at least a second before the SIGKILL,
      // and the workers stop before the watchdog.
      expect(plan.timeoutMs, `g=${grace}`).toBeLessThanOrEqual(grace - 1_000);
      expect(workersEndAt(plan), `g=${grace}`).toBeLessThanOrEqual(
        plan.timeoutMs,
      );
      expect(shutdownPlanProblems(plan), `g=${grace}`).toEqual([]);

      for (const value of Object.values(plan)) {
        expect(Number.isInteger(value), `g=${grace}`).toBe(true);
        expect(value, `g=${grace}`).toBeGreaterThan(0);
      }
    }
  });

  it("takes an override in place of the derived figure", () => {
    expect(
      planShutdown(40_000, { drainMs: 3_000, workersMs: 8_000 }),
    ).toMatchObject({ drainMs: 3_000, workersMs: 8_000, timeoutMs: 35_000 });

    expect(planShutdown(40_000, { importGraceMs: 0 }).importGraceMs).toBe(0);
    expect(planShutdown(40_000, { timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });
});

describe("shutdownPlanProblems", () => {
  it("refuses a watchdog that would outlive the grace", () => {
    const problems = shutdownPlanProblems(
      planShutdown(10_000, { timeoutMs: 9_500 }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SHUTDOWN_TIMEOUT_MS/);
    expect(problems[0]).toMatch(/STOP_GRACE_PERIOD_MS/);
  });

  it("refuses steps that would not end before the watchdog", () => {
    const problems = shutdownPlanProblems(
      planShutdown(40_000, { workersMs: 20_000 }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SHUTDOWN_WORKERS_MS/);
    expect(problems[0]).toMatch(/35000/);
  });
});

describe("shutdownPlanFor", () => {
  it("does not drain outside production, where nothing routes to the process and Ctrl+C should be instant", () => {
    const plan = shutdownPlanFor({
      NODE_ENV: "development",
      STOP_GRACE_PERIOD_MS: 40_000,
    });

    expect(plan).toMatchObject({ drainMs: 0, importGraceMs: 0 });
    expect(plan.workersMs).toBe(12_000);
  });

  it("drains in production, and an explicit override wins anywhere", () => {
    expect(
      shutdownPlanFor({ NODE_ENV: "production", STOP_GRACE_PERIOD_MS: 40_000 }),
    ).toEqual(planShutdown(40_000));

    expect(
      shutdownPlanFor({
        NODE_ENV: "development",
        STOP_GRACE_PERIOD_MS: 40_000,
        SHUTDOWN_DRAIN_MS: 2_000,
      }).drainMs,
    ).toBe(2_000);
  });
});

describe("the environment", () => {
  it("assumes Docker's 10 s grace when the variable is absent or empty", () => {
    for (const value of [undefined, ""]) {
      const parsed = parse(
        value === undefined ? {} : { STOP_GRACE_PERIOD_MS: value },
      );

      expect(parsed.success).toBe(true);
      expect(
        (parsed.data as { STOP_GRACE_PERIOD_MS: number }).STOP_GRACE_PERIOD_MS,
      ).toBe(10_000);
    }
  });

  it("refuses a grace outside 7–300 s", () => {
    expect(parse({ STOP_GRACE_PERIOD_MS: "6999" }).success).toBe(false);
    expect(parse({ STOP_GRACE_PERIOD_MS: "300001" }).success).toBe(false);
    expect(parse({ STOP_GRACE_PERIOD_MS: "40000" }).success).toBe(true);
  });

  it("fails the boot on an override that breaks the plan, naming it", () => {
    const parsed = parse({
      STOP_GRACE_PERIOD_MS: "40000",
      SHUTDOWN_WORKERS_MS: "30000",
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/SHUTDOWN_WORKERS_MS/);

    // The same override fits a longer grace.
    expect(
      parse({ STOP_GRACE_PERIOD_MS: "120000", SHUTDOWN_WORKERS_MS: "30000" })
        .success,
    ).toBe(true);
  });

  it("fails the boot on a watchdog past the grace", () => {
    expect(parse({ SHUTDOWN_TIMEOUT_MS: "10000" }).success).toBe(false);
    expect(
      parse({ STOP_GRACE_PERIOD_MS: "40000", SHUTDOWN_TIMEOUT_MS: "34000" })
        .success,
    ).toBe(true);
  });

  it("takes empty overrides as absent", () => {
    expect(
      parse({
        SHUTDOWN_TIMEOUT_MS: "",
        SHUTDOWN_DRAIN_MS: "",
        IMPORT_DRAIN_GRACE_MS: "",
        SHUTDOWN_WORKERS_MS: "",
      }).success,
    ).toBe(true);
  });
});
