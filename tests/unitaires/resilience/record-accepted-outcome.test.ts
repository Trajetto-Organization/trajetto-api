import { describe, expect, it } from "vitest";

import {
  RECORD_LEASE_MARGIN_MS,
  recordAcceptedOutcome,
  recordDeadline,
} from "@/shared/resilience/record-accepted-outcome";

/**
 * The schedule that records a send the provider already accepted. A virtual
 * clock stands in for time; the write is a real function whose failures are
 * staged by that clock (the database is "down" until a given instant).
 */
function virtualClock() {
  let now = 1_000_000;

  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function databaseDownUntil(clock: { now: () => number }, upAt: number) {
  const attempts: number[] = [];
  let recorded = 0;

  return {
    attempts,
    recorded: () => recorded,
    write: async () => {
      attempts.push(clock.now());
      if (clock.now() < upAt) throw new Error("Can't reach database server");
      recorded += 1;
    },
  };
}

describe("recording a send the provider accepted", () => {
  it("survives a 30 s database outage: recorded once it is back, without holding the batch", async () => {
    const clock = virtualClock();
    const startedAt = clock.now();
    const db = databaseDownUntil(clock, startedAt + 30_000);
    const pending: Promise<void>[] = [];
    let gaveUp = 0;
    let detachedAt = 0;
    let recordedWhenDetached = -1;

    await recordAcceptedOutcome({
      write: db.write,
      deadline: recordDeadline(startedAt, 180),
      onDetached: () => {
        detachedAt = clock.now();
        recordedWhenDetached = db.recorded();
      },
      onGiveUp: () => (gaveUp += 1),
      track: (p) => pending.push(p),
      now: clock.now,
      sleep: clock.sleep,
    });

    // The batch got control back after the quick retries (250 + 1000 + 3000).
    expect(detachedAt - startedAt).toBe(4_250);
    expect(recordedWhenDetached).toBe(0);
    expect(pending).toHaveLength(1);

    await Promise.all(pending);

    expect(db.recorded()).toBe(1);
    expect(gaveUp).toBe(0);
    // Backed off, not a hot loop: a handful of tries over 30 s.
    expect(db.attempts.length).toBeLessThanOrEqual(10);
  });

  it("stops before the lease ends, so a reclaiming replica is never raced", async () => {
    const clock = virtualClock();
    const startedAt = clock.now();
    const db = databaseDownUntil(clock, Number.POSITIVE_INFINITY);
    const pending: Promise<void>[] = [];
    let gaveUp = 0;

    await recordAcceptedOutcome({
      write: db.write,
      deadline: recordDeadline(startedAt, 180),
      onGiveUp: () => (gaveUp += 1),
      track: (p) => pending.push(p),
      now: clock.now,
      sleep: clock.sleep,
    });
    await Promise.all(pending);

    expect(gaveUp).toBe(1);
    expect(db.recorded()).toBe(0);

    const lastTry = Math.max(...db.attempts);

    expect(lastTry).toBeLessThanOrEqual(
      startedAt + 180_000 - RECORD_LEASE_MARGIN_MS,
    );
    // Kept trying for most of the lease, not just four seconds.
    expect(lastTry - startedAt).toBeGreaterThan(150_000);
  });

  it("writes once and returns when the database answers", async () => {
    const clock = virtualClock();
    const db = databaseDownUntil(clock, 0);
    const pending: Promise<void>[] = [];

    await recordAcceptedOutcome({
      write: db.write,
      deadline: recordDeadline(clock.now(), 180),
      onGiveUp: () => {
        throw new Error("never");
      },
      track: (p) => pending.push(p),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(db.attempts).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  it("gives up at once when the claim's lease is already nearly over", async () => {
    const clock = virtualClock();
    const db = databaseDownUntil(clock, Number.POSITIVE_INFINITY);
    let gaveUp = 0;

    await recordAcceptedOutcome({
      write: db.write,
      // Claimed 170 s ago with a 180 s lease: inside the margin.
      deadline: recordDeadline(clock.now() - 170_000, 180),
      onGiveUp: () => (gaveUp += 1),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(db.attempts).toHaveLength(1);
    expect(gaveUp).toBe(1);
  });
});
