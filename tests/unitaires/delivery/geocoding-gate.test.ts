import { describe, expect, it } from "vitest";

import {
  EXTEND_PAUSE,
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE,
  GEOCODING_CALLS_PER_MINUTE,
  GEOCODING_CALLS_PER_SECOND,
  MINUTE_LOG_KEY,
  MINUTE_MS,
  PAUSE_KEY,
  TAKE_SLOT,
  createRedisGeocodingGate,
  pauseDeadlineOf,
  pauseReasonOf,
  pauseValue,
  slotKey,
} from "@/shared/delivery/geocoding/geocoding-gate";

/**
 * When the geocoder may call the provider (owner's report of 09/11/2026):
 * the pause every replica honours after a refusal or a 429, and the
 * per-second slot the minute's job and the lookups after a commit share.
 * Both in Redis, both failing CLOSED — a lookup put off costs a minute, one
 * the provider refuses costs an attempt or the quota.
 */
const NOW = new Date("2026-11-09T15:00:00.000Z");

function fakeRedis(failing = false) {
  const values = new Map<string, { value: string; ttlMs: number | null }>();
  const counts = new Map<string, number>();
  /** The minute's logs: the times (ms) of the calls each one holds. */
  const logs = new Map<string, number[]>();

  return {
    values,
    counts,
    logs,
    redis: {
      async get(key: string) {
        if (failing) throw new Error("ECONNREFUSED");

        return values.get(key)?.value ?? null;
      },
      async eval(
        script: string,
        _keys: number,
        key: string,
        ...args: unknown[]
      ) {
        if (failing) throw new Error("ECONNREFUSED");

        if (script === EXTEND_PAUSE) {
          const [value, ms] = args as [string, number];
          const left = values.get(key)?.ttlMs ?? -2;

          if (left < Number(ms)) values.set(key, { value, ttlMs: Number(ms) });

          return 1;
        }

        if (script === TAKE_SLOT) {
          // Both or neither, as the script does in Redis (the script itself
          // runs against Redis in tests/E2E/geocoding-gate-redis.test.ts).
          const [minute, perSecond, perMinute, , now, window] = args as [
            string,
            number,
            number,
            number,
            number,
            number,
          ];

          if ((counts.get(key) ?? 0) >= Number(perSecond)) return 0;

          const log = (logs.get(minute) ?? []).filter(
            (at) => at > Number(now) - Number(window),
          );

          logs.set(minute, log);

          if (log.length >= Number(perMinute)) return 0;

          counts.set(key, (counts.get(key) ?? 0) + 1);
          log.push(Number(now));

          return 1;
        }

        counts.set(key, (counts.get(key) ?? 0) + 1);

        return counts.get(key);
      },
    },
  };
}

describe("the geocoding pause", () => {
  it("holds every replica until it ends, and never shortens a longer one", async () => {
    const { redis, values } = fakeRedis();
    const gate = createRedisGeocodingGate(redis as never);

    expect(await gate.paused(NOW)).toBe(false);

    await gate.pause(new Date("2026-11-10T00:00:00.000Z"), NOW, "QUOTA");

    expect(await gate.paused(NOW)).toBe(true);
    expect(values.get(PAUSE_KEY)).toEqual({
      value: "QUOTA 2026-11-10T00:00:00.000Z",
      ttlMs: 9 * 60 * 60 * 1000,
    });

    // A burst's minute after the day's quota: the day's pause stays,
    // with its reason.
    await gate.pause(new Date(NOW.getTime() + 60_000), NOW, "BURST");

    expect(values.get(PAUSE_KEY)).toEqual({
      value: "QUOTA 2026-11-10T00:00:00.000Z",
      ttlMs: 9 * 60 * 60 * 1000,
    });
  });

  it("keeps the reason beside the deadline, for the route read", () => {
    const until = new Date(NOW.getTime() + 15 * 60_000);

    expect(pauseValue("REFUSED", until)).toBe(
      "REFUSED 2026-11-09T15:15:00.000Z",
    );
    expect(pauseReasonOf(pauseValue("REFUSED", until))).toBe("REFUSED");
    expect(pauseReasonOf(pauseValue("QUOTA", until))).toBe("QUOTA");
    expect(pauseReasonOf(pauseValue("BURST", until))).toBe("BURST");
    expect(pauseReasonOf(null)).toBeNull();
    expect(pauseReasonOf("2026-11-09T15:15:00.000Z")).toBeNull();

    // The deadline too, for the address search's retry-after.
    expect(pauseDeadlineOf(pauseValue("QUOTA", until))).toEqual(until);
    expect(pauseDeadlineOf("QUOTA")).toBeNull();
    expect(pauseDeadlineOf(null)).toBeNull();
  });

  it("ignores a deadline already past", async () => {
    const { redis, values } = fakeRedis();
    const gate = createRedisGeocodingGate(redis as never);

    await gate.pause(new Date(NOW.getTime() - 1), NOW, "BURST");

    expect(values.size).toBe(0);
  });

  it("reads as paused when Redis does not answer", async () => {
    const errors: unknown[] = [];
    const gate = createRedisGeocodingGate(fakeRedis(true).redis as never, {
      onError: (err) => errors.push(err),
    });

    expect(await gate.paused(NOW)).toBe(true);
    await gate.pause(new Date(NOW.getTime() + 60_000), NOW, "BURST");
    expect(errors).toHaveLength(2);
  });
});

describe("the per-second slot", () => {
  it("gives one call a second across every caller, the other left to the proof's reverse lookup", async () => {
    const { redis } = fakeRedis();
    let clock = NOW.getTime();

    const job = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });
    const soon = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });

    expect(GEOCODING_CALLS_PER_SECOND).toBe(1);
    expect(await job.takeSlot()).toBe(true);
    expect(await soon.takeSlot()).toBe(false);
    expect(await job.takeSlot()).toBe(false);

    clock += 1_000;

    expect(await soon.takeSlot()).toBe(true);
    expect(slotKey(Math.floor(clock / 1000))).toBe(
      `geocoding:deliveries:rate:${Math.floor(clock / 1000)}`,
    );
  });

  it("gives no slot when Redis does not answer", async () => {
    const gate = createRedisGeocodingGate(fakeRedis(true).redis as never);

    expect(await gate.takeSlot()).toBe(false);
  });

  it("counts the old replicas' refused tries in the same second (rolling deploy)", async () => {
    const { redis, counts } = fakeRedis();
    const clock = NOW.getTime();
    const gate = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });

    // A replica before the minute's window INCRs and compares after.
    counts.set(slotKey(Math.floor(clock / 1000)), 2);

    expect(await gate.takeSlot()).toBe(false);
    expect(counts.get(slotKey(Math.floor(clock / 1000)))).toBe(2);
  });
});

/**
 * The free tier's 60 calls a minute (synthesis of the pin-search plan): a
 * call a second already makes 60, and the proof's reverse lookups come on
 * top. Unmodelled, the 61st met a 429, the BURST pause, and every path
 * stopped for a minute. Counted over any 60 s: in the clock's minutes, 50
 * at the end of one and 50 at the start of the next made 60 within a
 * minute, and the proofs' ten were gone.
 */
describe("the per-minute slot", () => {
  const START = Date.UTC(2026, 10, 9, 15, 0, 0);

  it("stops the search at 50 calls in 60 s and the background paths at 40", async () => {
    const { redis, logs } = fakeRedis();
    let clock = START;

    const job = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });
    const search = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
      perMinute: GEOCODING_CALLS_PER_MINUTE,
    });

    expect(GEOCODING_CALLS_PER_MINUTE).toBe(50);
    expect(GEOCODING_BACKGROUND_CALLS_PER_MINUTE).toBe(40);
    expect(MINUTE_MS).toBe(60_000);

    let jobCalls = 0;

    for (let second = 0; second < 45; second += 1) {
      if (await job.takeSlot()) jobCalls += 1;
      clock += 1_000;
    }

    expect(jobCalls).toBe(40);
    expect(logs.get(MINUTE_LOG_KEY)).toHaveLength(40);

    // The tail of the 60 s is the search's.
    let searchCalls = 0;

    for (let second = 45; second < 60; second += 1) {
      if (await search.takeSlot()) searchCalls += 1;
      if (await job.takeSlot()) jobCalls += 1;
      clock += 1_000;
    }

    expect(searchCalls).toBe(10);
    expect(jobCalls).toBe(40);
    expect(logs.get(MINUTE_LOG_KEY)).toHaveLength(50);

    // The clock's next minute opens nothing: 49 calls of the last 60 s are
    // still in the log at 1:00, and the job waits for its first ten to be
    // 60 s old.
    expect(await job.takeSlot()).toBe(false);

    clock = START + 70_000;

    expect(await job.takeSlot()).toBe(true);
  });

  it("never grants more than 50 in any 60 s, across the clock's minutes", async () => {
    const { redis } = fakeRedis();
    // Half a minute in: the clock's minute turns in the middle of the run.
    let clock = START + 30_000;
    const search = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
      perMinute: GEOCODING_CALLS_PER_MINUTE,
    });

    const granted: number[] = [];

    for (let second = 0; second < 300; second += 1) {
      if (await search.takeSlot()) granted.push(clock);
      clock += 1_000;
    }

    const busiest = Math.max(
      ...granted.map(
        (at) =>
          granted.filter((other) => other >= at && other < at + 60_000).length,
      ),
    );

    expect(busiest).toBe(50);
    expect(granted.length).toBeGreaterThanOrEqual(240);
  });

  it("never spends the second's slot on a call the minute refuses", async () => {
    const { redis, counts, logs } = fakeRedis();
    const clock = START + 30_000;
    const job = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });
    const search = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
      perMinute: GEOCODING_CALLS_PER_MINUTE,
    });

    logs.set(
      MINUTE_LOG_KEY,
      Array.from(
        { length: GEOCODING_BACKGROUND_CALLS_PER_MINUTE },
        (_, index) => clock - 20_000 + index,
      ),
    );

    expect(await job.takeSlot()).toBe(false);
    expect(counts.get(slotKey(Math.floor(clock / 1000)))).toBeUndefined();
    expect(logs.get(MINUTE_LOG_KEY)).toHaveLength(40);

    // The same second is still free for the search.
    expect(await search.takeSlot()).toBe(true);
    expect(logs.get(MINUTE_LOG_KEY)).toHaveLength(41);
  });

  it("asks Redis with the call's time and a member of its own", async () => {
    const asked: unknown[][] = [];
    const gate = createRedisGeocodingGate(
      {
        get: async () => null,
        eval: async (...args: unknown[]) => {
          asked.push(args);
          return 1;
        },
      } as never,
      { clock: () => START },
    );

    await gate.takeSlot();
    await gate.takeSlot();

    expect(asked[0].slice(0, 9)).toEqual([
      TAKE_SLOT,
      2,
      slotKey(START / 1000),
      MINUTE_LOG_KEY,
      GEOCODING_CALLS_PER_SECOND,
      GEOCODING_BACKGROUND_CALLS_PER_MINUTE,
      2,
      START,
      MINUTE_MS,
    ]);
    expect(String(asked[0][9])).toMatch(new RegExp(`^${START}:`));
    expect(asked[0][9]).not.toBe(asked[1][9]);
  });
});
