import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import { env } from "@/env";
import {
  HANDSHAKE_WINDOW_SECONDS,
  createHandshakeLimiter,
} from "@/shared/socket/handshake-rate-limit";

/**
 * The handshake counter's window, against a real Redis.
 *
 * The limiter used to INCR and then, in a second command, EXPIRE only when
 * the count was 1. Anything that lost that second command — the connection
 * dropping with the EXPIRE in flight, ioredis replaying an INCR after a
 * reconnect (it then answers 2 and the EXPIRE branch is skipped), a 250 ms
 * command timeout firing on a slow INCR — left a counter with no TTL. No later
 * INCR ever answered 1 again, so the window never came back: after 30
 * attempts a user, or after 300 an entire office behind one NAT, was refused
 * realtime for good, and Redis persists the key across restarts.
 *
 * A key with no TTL is exactly what those failures leave behind, so each test
 * seeds one directly rather than trying to time a network fault.
 */
let redis: Redis;

const keys: string[] = [];

function freshKey(): string {
  const key = `socket-handshake:window-test:${randomUUID()}`;
  keys.push(key);

  return key;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  await new Promise<void>((settle, reject) => {
    redis.once("ready", settle);
    redis.once("error", reject);
  });
});

afterAll(async () => {
  if (keys.length > 0) await redis?.del(...keys);

  await redis?.quit();
});

describe("a bucket that lost its window", () => {
  it("gets the window back on its next attempt", async () => {
    const key = freshKey();

    // What a lost EXPIRE leaves behind: a count, and no expiry.
    await redis.set(key, "5");
    expect(await redis.pttl(key)).toBe(-1);

    const limiter = createHandshakeLimiter(redis);

    expect(await limiter.allow(key, 300)).toBe(true);

    const pttl = await redis.pttl(key);

    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(HANDSHAKE_WINDOW_SECONDS * 1000);
  });

  it("is refused while over budget, but only until the window ends", async () => {
    const key = freshKey();

    // A stuck office bucket, long past its budget.
    await redis.set(key, "500");

    const limiter = createHandshakeLimiter(redis);

    expect(await limiter.allow(key, 300)).toBe(false);

    // Refused NOW is the limiter doing its job; refused FOREVER was the bug.
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });
});

describe("a fresh bucket", () => {
  it("counts from one and arms the window at once", async () => {
    const key = freshKey();
    const limiter = createHandshakeLimiter(redis);

    expect(await limiter.allow(key, 1)).toBe(true);
    expect(await redis.get(key)).toBe("1");
    expect(await redis.pttl(key)).toBeGreaterThan(0);

    expect(await limiter.allow(key, 1)).toBe(false);
  });

  it("keeps the window anchored to the first attempt", async () => {
    const key = freshKey();
    const limiter = createHandshakeLimiter(redis);

    await limiter.allow(key, 10);

    // Shorten the window so a push forward would be visible.
    await redis.pexpire(key, 5_000);

    await limiter.allow(key, 10);
    await limiter.allow(key, 10);

    // Re-arming on every attempt would let a steady stream of connections
    // keep one bucket alive forever, and its count would never reset.
    expect(await redis.pttl(key)).toBeLessThanOrEqual(5_000);
    expect(await redis.get(key)).toBe("3");
  });
});
