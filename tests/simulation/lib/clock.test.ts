import { describe, expect, it } from "vitest";

import { SimClock } from "./clock";

/** A wall clock and a sleep that only move when the test says so. */
function manualTime(start = Date.UTC(2026, 10, 3, 11, 0, 0)) {
  let now = start;
  const sleeps: number[] = [];

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe("SimClock", () => {
  it("runs simulated time SPEED times faster than the wall clock", () => {
    const time = manualTime();
    const clock = new SimClock({ speed: 8, now: time.now, sleep: time.sleep });

    time.advance(1_000);

    expect(clock.elapsedSimMs()).toBe(8_000);
    expect(clock.simNow() - clock.startedAt).toBe(8_000);
    expect(clock.wallNow()).toBe(clock.startedAt + 1_000);
  });

  it("sleeps simulated time as wall time divided by the speed", async () => {
    const time = manualTime();
    const clock = new SimClock({ speed: 8, now: time.now, sleep: time.sleep });

    await clock.sleepSim(60_000);

    expect(time.sleeps).toEqual([7_500]);
    expect(clock.elapsedSimMs()).toBe(60_000);
  });

  it("converts both ways", () => {
    const clock = new SimClock({ speed: 20 });

    expect(clock.toWallMs(60_000)).toBe(3_000);
    expect(clock.toSimMs(3_000)).toBe(60_000);
  });

  it("skips a non-positive sleep", async () => {
    const time = manualTime();
    const clock = new SimClock({ speed: 8, now: time.now, sleep: time.sleep });

    await clock.sleepSim(0);
    await clock.sleepSim(-5);

    expect(time.sleeps).toEqual([]);
  });

  it("refuses a speed that is not a positive number", () => {
    expect(() => new SimClock({ speed: 0 })).toThrow();
    expect(() => new SimClock({ speed: Number.NaN })).toThrow();
  });

  it("stamps wall-clock ISO instants, which is what the phone sends", () => {
    const time = manualTime(Date.UTC(2026, 10, 3, 11, 0, 0));
    const clock = new SimClock({ speed: 8, now: time.now, sleep: time.sleep });

    time.advance(2_500);

    expect(clock.wallIso()).toBe("2026-11-03T11:00:02.500Z");
    expect(clock.simIso()).toBe("2026-11-03T11:00:20.000Z");
  });
});
