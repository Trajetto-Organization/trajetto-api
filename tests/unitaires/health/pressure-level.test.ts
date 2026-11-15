import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  POSITIONS_FLUSH_AFTER_MAX_MS,
  createEluWindow,
  positionsFlushAfterMs,
  pressureLevelFor,
} from "@/shared/health/pressure-level";

/**
 * How long the driver's app should wait before its next positions flush,
 * from how pressed the replica that answered is (plano-escala F2-26).
 *
 * The phones flush every 60 s whatever the server is going through: a
 * replica with its event loop saturated got the same 333 POST/s at 20k
 * drivers as an idle one, and every late answer made the app retry sooner.
 * The answer now carries `nextFlushAfterMs` — 60 s normally, 120 s with the
 * event loop over 70%, 300 s over 90% or while load is being shed — and
 * the app waits the longer of it and its own interval (F2-27). The points
 * are kept on the phone meanwhile: nothing is lost, the map only lags.
 */

describe("pressureLevelFor", () => {
  it.each([
    [0, false, "normal"],
    [0.69, false, "normal"],
    [0.7, false, "elevated"],
    [0.89, false, "elevated"],
    [0.9, false, "critical"],
    [1, false, "critical"],
    [0.1, true, "critical"],
  ] as const)("ELU %s, shedding %s: %s", (elu, shedding, level) => {
    expect(pressureLevelFor({ elu, shedding })).toBe(level);
  });

  it("reads a broken reading as normal, never as a reason to slow the fleet", () => {
    expect(pressureLevelFor({ elu: Number.NaN, shedding: false })).toBe(
      "normal",
    );
    expect(pressureLevelFor({ elu: -1, shedding: false })).toBe("normal");
  });
});

describe("positionsFlushAfterMs", () => {
  it("gives 60, 120 and 300 s with the default base", () => {
    expect(positionsFlushAfterMs("normal", 60_000)).toBe(60_000);
    expect(positionsFlushAfterMs("elevated", 60_000)).toBe(120_000);
    expect(positionsFlushAfterMs("critical", 60_000)).toBe(300_000);
  });

  it("stays between the base and the app's 5-minute ceiling for any base", () => {
    for (const base of [15_000, 30_000, 60_000, 90_000, 200_000, 300_000]) {
      for (const level of ["normal", "elevated", "critical"] as const) {
        const hint = positionsFlushAfterMs(level, base);

        expect(hint, `${level} ${base}`).toBeGreaterThanOrEqual(base);
        expect(hint, `${level} ${base}`).toBeLessThanOrEqual(
          POSITIONS_FLUSH_AFTER_MAX_MS,
        );
      }
    }

    expect(POSITIONS_FLUSH_AFTER_MAX_MS).toBe(300_000);
  });
});

describe("createEluWindow", () => {
  /** A fake event-loop clock: idle and active time, in ms, as Node counts. */
  function fakeLoop() {
    const state = { idle: 0, active: 0 };

    return {
      state,
      read: () => ({
        idle: state.idle,
        active: state.active,
        utilization: 0,
      }),
    };
  }

  it("answers the utilization of the last full window, read without a timer", () => {
    const loop = fakeLoop();
    let now = 0;

    const window = createEluWindow({
      windowMs: 5_000,
      read: loop.read,
      now: () => now,
    });

    // The first window: 80% busy.
    loop.state.active = 4_000;
    loop.state.idle = 1_000;
    now = 5_000;

    expect(window.current()).toBeCloseTo(0.8);

    // Inside the next window the last full one still answers.
    loop.state.active += 500;
    loop.state.idle += 500;
    now = 6_000;

    expect(window.current()).toBeCloseTo(0.8);

    // Then that window closes: 20% busy over it.
    loop.state.active += 500;
    loop.state.idle += 3_500;
    now = 10_000;

    expect(window.current()).toBeCloseTo(0.2);
  });

  it("answers the time so far before the first window closes", () => {
    const loop = fakeLoop();
    let now = 0;

    const window = createEluWindow({
      windowMs: 5_000,
      read: loop.read,
      now: () => now,
    });

    loop.state.active = 300;
    loop.state.idle = 700;
    now = 1_000;

    expect(window.current()).toBeCloseTo(0.3);
  });
});

describe("POSITIONS_FLUSH_AFTER_MS", () => {
  const base = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (value?: string) => {
    const parsed = envSchema.safeParse(
      value === undefined ? base : { ...base, POSITIONS_FLUSH_AFTER_MS: value },
    );

    return parsed.success
      ? (parsed.data as { POSITIONS_FLUSH_AFTER_MS: number })
          .POSITIONS_FLUSH_AFTER_MS
      : "refused";
  };

  it("is 60 s unless set, between the app's 15 s point and its 5-minute ceiling", () => {
    expect(parse()).toBe(60_000);
    expect(parse("")).toBe(60_000);
    expect(parse("90000")).toBe(90_000);
    expect(parse("14999")).toBe("refused");
    expect(parse("300001")).toBe("refused");
  });
});
