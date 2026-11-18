import { describe, expect, it, vi } from "vitest";

import {
  MAX_PENALTY_MS,
  MAX_WAIT_MS,
  PENALIZE_RATE,
  REDIS_RETRY_MS,
  TAKE_RATE,
  THROTTLE_PAUSE_MS,
  countProviderThrottle,
  createProviderRateBucket,
  emissionIntervalMs,
  gcraTake,
  rateKey,
  takeProviderRateCounts,
  throttlePauseMs,
} from "@/shared/notifications/provider-rate-bucket";
import type { Provider } from "@/shared/notifications/provider-caps";

/**
 * The providers' rate, platform-wide (plano-escala F3-15c; decision D45).
 * The global caps bound the sends in flight, never the sends a second:
 * four slots of 100 ms sends are ~40 requests a second against Resend's
 * 10. What this pins:
 *
 *  - the bucket's math: at 5/s, never more than 5 sends start in any
 *    second, whatever the arrivals; a place further than the longest wait
 *    is refused and leaves the bucket as it was;
 *  - off (0, the default) reads nothing: no Redis, no wait;
 *  - Redis' answer decides when it answers; when it does not, each
 *    process keeps its share of the rate, rate / the lane's divisor
 *    (F3-15a), so together they stay under it;
 *  - a provider's 429 holds the provider, within a minute;
 *  - what the minute's ops_sample row counts.
 *
 * The Lua runs against a real Redis in tests/E2E/provider-rate-bucket.test.ts.
 */

const RATES_OFF: Record<Provider, number> = { whatsapp: 0, email: 0, push: 0 };

/** Sends in the busiest half-open window of `windowMs`. */
function busiestWindow(starts: number[], windowMs = 1_000): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let most = 0;

  for (let first = 0; first < sorted.length; first += 1) {
    let inside = 0;

    for (let next = first; next < sorted.length; next += 1) {
      if (sorted[next] - sorted[first] < windowMs) inside += 1;
    }

    most = Math.max(most, inside);
  }

  return most;
}

describe("the bucket's math (GCRA with no burst)", () => {
  it("lets no more than the rate start in any second, however they arrive", () => {
    const interval = emissionIntervalMs(5);
    let tat = 0;
    const starts: number[] = [];

    // Bursts of ten every 300 ms for five seconds: far more than 5/s.
    for (let now = 0; now < 5_000; now += 300) {
      for (let n = 0; n < 10; n += 1) {
        const answer = gcraTake(tat, now, interval, 1, MAX_WAIT_MS);

        if (answer.granted) {
          starts.push(now + answer.waitMs);
          tat = answer.tat;
        }
      }
    }

    expect(starts.length).toBeGreaterThan(20);
    expect(busiestWindow(starts)).toBeLessThanOrEqual(5);
  });

  it("refuses a place past the longest wait, and leaves the bucket as it was", () => {
    const answer = gcraTake(10_000, 8_000, 200, 1, MAX_WAIT_MS);

    expect(answer).toEqual({ granted: false, waitMs: 2_000, tat: 10_000 });
  });

  it("moves the bucket by the cost: a push to three phones is three", () => {
    expect(gcraTake(0, 1_000, 2, 3, MAX_WAIT_MS)).toEqual({
      granted: true,
      waitMs: 0,
      tat: 1_006,
    });
  });

  it("rounds the interval up, never over the rate", () => {
    expect(emissionIntervalMs(5)).toBe(200);
    expect(emissionIntervalMs(8)).toBe(125);
    expect(emissionIntervalMs(60)).toBe(17);
    expect(emissionIntervalMs(500)).toBe(2);
    expect(emissionIntervalMs(1_000)).toBe(1);
  });
});

describe("the bucket with the rate off", () => {
  it("answers off and opens no Redis connection", async () => {
    const redis = vi.fn();
    const bucket = createProviderRateBucket({
      rates: () => RATES_OFF,
      redis,
      divisor: async () => 1,
    });

    expect(bucket.enabled("whatsapp")).toBe(false);
    expect(await bucket.take("whatsapp")).toEqual({ kind: "off" });

    await bucket.penalize("whatsapp", 5_000);

    expect(redis).not.toHaveBeenCalled();
  });
});

describe("the bucket on Redis", () => {
  function onRedis(answer: unknown) {
    const evalSpy = vi.fn(async () => answer);
    const bucket = createProviderRateBucket({
      rates: () => ({ ...RATES_OFF, email: 8 }),
      redis: () => ({ eval: evalSpy }) as never,
      divisor: async () => 1,
      namespace: () => "test-ns",
    });

    return { bucket, evalSpy };
  }

  it("goes after the wait Redis reserved", async () => {
    const { bucket, evalSpy } = onRedis([1, 375, 1_000_375]);

    expect(await bucket.take("email")).toEqual({
      kind: "go",
      waitMs: 375,
      local: false,
    });
    expect(evalSpy).toHaveBeenCalledWith(
      TAKE_RATE,
      1,
      "test-ns:email",
      125,
      1,
      MAX_WAIT_MS,
    );
  });

  it("comes back later when the place is past the longest wait", async () => {
    takeProviderRateCounts();

    const { bucket } = onRedis([0, 1_500, 1_001_500]);

    expect(await bucket.take("email")).toEqual({
      kind: "later",
      retryInMs: 1_500,
      local: false,
    });
    expect(takeProviderRateCounts()?.deferred.email).toBe(1);
  });

  it("holds the provider for a 429's pause, within a minute", async () => {
    const { bucket, evalSpy } = onRedis(1);

    await bucket.penalize("email", 10 * 60_000);

    expect(evalSpy).toHaveBeenCalledWith(
      PENALIZE_RATE,
      1,
      rateKey("test-ns", "email"),
      MAX_PENALTY_MS,
    );
  });
});

describe("the bucket with Redis away", () => {
  it("keeps this process's share: the rate divided by the lane's processes", async () => {
    takeProviderRateCounts();

    let now = 1_000_000;
    const divisor = vi.fn(async () => 2);
    const bucket = createProviderRateBucket({
      rates: () => ({ ...RATES_OFF, whatsapp: 10 }),
      redis: () =>
        ({
          eval: async () => {
            throw new Error("Command timed out");
          },
        }) as never,
      divisor,
      now: () => now,
    });

    const answers = [];

    for (let n = 0; n < 7; n += 1) answers.push(await bucket.take("whatsapp"));

    // 10/s over two processes: 5/s here, a place every 200 ms.
    expect(answers.slice(0, 6)).toEqual(
      [0, 200, 400, 600, 800, 1_000].map((waitMs) => ({
        kind: "go",
        waitMs,
        local: true,
      })),
    );
    expect(answers[6]).toEqual({
      kind: "later",
      retryInMs: 1_200,
      local: true,
    });
    expect(divisor).toHaveBeenCalled();

    // A second later the share has room again.
    now += 1_200;

    expect(await bucket.take("whatsapp")).toEqual({
      kind: "go",
      waitMs: 0,
      local: true,
    });

    const counted = takeProviderRateCounts();

    expect(counted?.local.whatsapp).toBe(8);
    expect(counted?.deferred.whatsapp).toBe(1);
  });

  it("asks Redis again only after a pause, not paying its timeout on every send", async () => {
    let now = 0;
    const evalSpy = vi.fn(async () => {
      throw new Error("Command timed out");
    });
    const bucket = createProviderRateBucket({
      rates: () => ({ ...RATES_OFF, email: 8 }),
      redis: () => ({ eval: evalSpy }) as never,
      divisor: async () => 1,
      now: () => now,
    });

    await bucket.take("email");
    await bucket.take("email");
    await bucket.penalize("email", 1_000);

    expect(evalSpy).toHaveBeenCalledTimes(1);

    now += REDIS_RETRY_MS;
    evalSpy.mockResolvedValueOnce([1, 0, now] as never);

    expect(await bucket.take("email")).toEqual({
      kind: "go",
      waitMs: 0,
      local: false,
    });
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });

  it("divides by 1 when the divisor cannot be read either", async () => {
    const bucket = createProviderRateBucket({
      rates: () => ({ ...RATES_OFF, push: 500 }),
      redis: () => {
        throw new Error("ECONNREFUSED");
      },
      divisor: async () => {
        throw new Error("database away");
      },
      now: () => 0,
    });

    expect(await bucket.take("push", 3)).toEqual({
      kind: "go",
      waitMs: 0,
      local: true,
    });
    // 500/s: the next unit starts 3 × 2 ms later.
    expect(await bucket.take("push")).toEqual({
      kind: "go",
      waitMs: 6,
      local: true,
    });
  });

  it("holds the share for a 429 too, should Redis go next", async () => {
    const bucket = createProviderRateBucket({
      rates: () => ({ ...RATES_OFF, email: 8 }),
      redis: () => {
        throw new Error("ECONNREFUSED");
      },
      divisor: async () => 1,
      now: () => 0,
    });

    await bucket.penalize("email", 5_000);

    expect(await bucket.take("email")).toEqual({
      kind: "later",
      retryInMs: 5_000,
      local: true,
    });
  });
});

describe("how long a 429 holds the provider", () => {
  it("is a second without Retry-After, the header within a minute otherwise", () => {
    expect(throttlePauseMs(undefined)).toBe(THROTTLE_PAUSE_MS);
    expect(throttlePauseMs(0)).toBe(THROTTLE_PAUSE_MS);
    expect(throttlePauseMs(200)).toBe(THROTTLE_PAUSE_MS);
    expect(throttlePauseMs(30_000)).toBe(30_000);
    expect(throttlePauseMs(3_600_000)).toBe(MAX_PENALTY_MS);
  });
});

describe("the minute's counts in ops_sample", () => {
  it("are null when nothing happened, and reset when read", () => {
    takeProviderRateCounts();

    expect(takeProviderRateCounts()).toBeNull();

    countProviderThrottle("whatsapp");
    countProviderThrottle("whatsapp");
    countProviderThrottle("email");

    expect(takeProviderRateCounts()).toEqual({
      throttled: { whatsapp: 2, email: 1, push: 0 },
      deferred: { whatsapp: 0, email: 0, push: 0 },
      local: { whatsapp: 0, email: 0, push: 0 },
    });
    expect(takeProviderRateCounts()).toBeNull();
  });
});
