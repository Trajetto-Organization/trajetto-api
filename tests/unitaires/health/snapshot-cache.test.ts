import { describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import {
  SnapshotCache,
  redisSnapshotStore,
  type SnapshotStore,
} from "@/shared/cache/snapshot-cache";

/**
 * The platform-level snapshots behind the MASTER's screens (providers'
 * readiness, the platform-wide dashboard): one computation per interval for
 * the whole deployment, not one per request, per tab and per replica — and
 * Redis only ever as an optimisation, never as a dependency.
 */

/** A Map standing in for Redis, with the TTL ignored (the clock is fake). */
function memoryStore(): SnapshotStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();

  return {
    entries,
    read: async (key) => entries.get(key) ?? null,
    write: async (key, value) => {
      entries.set(key, value);
    },
  };
}

function clock(start = 1_000_000) {
  let now = start;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("a snapshot cache", () => {
  it("computes once per interval and serves the copy in between", async () => {
    const time = clock();
    let calls = 0;
    const compute = vi.fn(async () => ({ n: (calls += 1) }));
    const cache = new SnapshotCache({
      name: "test",
      ttlMs: 10_000,
      compute,
      now: time.now,
    });

    expect(await cache.read()).toMatchObject({
      value: { n: 1 },
      cached: false,
    });

    time.advance(9_999);
    expect(await cache.read()).toMatchObject({ value: { n: 1 }, cached: true });

    time.advance(1);
    expect(await cache.read()).toMatchObject({
      value: { n: 2 },
      cached: false,
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("shares one computation between concurrent readers", async () => {
    let finish: (value: number) => void = () => {};
    const compute = vi.fn(
      () => new Promise<number>((resolve) => (finish = resolve)),
    );
    const cache = new SnapshotCache({ name: "test", ttlMs: 10_000, compute });

    const readers = Promise.all([cache.read(), cache.read(), cache.read()]);

    await new Promise((resolve) => setImmediate(resolve));
    finish(42);

    const answers = await readers;

    expect(compute).toHaveBeenCalledTimes(1);
    expect(answers.map((answer) => answer.value)).toEqual([42, 42, 42]);
  });

  it("serves what another replica computed, through the shared store", async () => {
    const time = clock();
    const store = memoryStore();

    const first = new SnapshotCache({
      name: "test",
      ttlMs: 30_000,
      compute: async () => "from replica A",
      store,
      now: time.now,
    });
    const otherCompute = vi.fn(async () => "from replica B");
    const second = new SnapshotCache({
      name: "test",
      ttlMs: 30_000,
      compute: otherCompute,
      store,
      now: time.now,
    });

    await first.read();
    await new Promise((resolve) => setImmediate(resolve));

    time.advance(5_000);

    expect(await second.read()).toMatchObject({
      value: "from replica A",
      cached: true,
    });
    expect(otherCompute).not.toHaveBeenCalled();

    // Past its TTL the shared copy is not served, whatever Redis still holds.
    time.advance(30_000);

    expect(await second.read()).toMatchObject({
      value: "from replica B",
      cached: false,
    });
  });

  it("recomputes on refresh, but at most once per minimum interval", async () => {
    const time = clock();
    let calls = 0;
    const compute = vi.fn(async () => (calls += 1));
    const cache = new SnapshotCache({
      name: "test",
      ttlMs: 30_000,
      minRefreshMs: 5_000,
      compute,
      now: time.now,
    });

    await cache.read();

    time.advance(1_000);
    expect(await cache.read({ refresh: true })).toMatchObject({
      cached: true,
    });

    time.advance(4_000);
    expect(await cache.read({ refresh: true })).toMatchObject({
      value: 2,
      cached: false,
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps a refresh from reading the shared copy back", async () => {
    const time = clock();
    const store = memoryStore();

    store.entries.set(
      `snapshot:${env.APP_ENV}:test`,
      JSON.stringify({ at: time.now(), value: "shared" }),
    );

    const cache = new SnapshotCache({
      name: "test",
      ttlMs: 30_000,
      minRefreshMs: 5_000,
      compute: async () => "fresh",
      store,
      now: time.now,
    });

    // The key is the one the store holds: a plain read serves it.
    expect(await cache.read()).toMatchObject({ value: "shared", cached: true });

    time.advance(5_000);

    expect(await cache.read({ refresh: true })).toMatchObject({
      value: "fresh",
      cached: false,
    });
  });

  it("caches nothing when the computation fails", async () => {
    const compute = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("recovered");
    const cache = new SnapshotCache({ name: "test", ttlMs: 10_000, compute });

    await expect(cache.read()).rejects.toThrow("database unavailable");
    expect(await cache.read()).toMatchObject({
      value: "recovered",
      cached: false,
    });
  });
});

describe("the Redis store", () => {
  it("reads as a miss when Redis is down or slow, within its deadline", async () => {
    const down = redisSnapshotStore(async () => {
      throw new Error("ECONNREFUSED");
    });
    const hung = redisSnapshotStore(
      async () => ({
        get: () => new Promise<string | null>(() => {}),
        set: () => new Promise(() => {}),
      }),
      50,
    );

    const startedAt = Date.now();

    expect(await down.read("k")).toBeNull();
    expect(await hung.read("k")).toBeNull();
    await expect(hung.write("k", "v", 1_000)).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("writes with the snapshot's TTL", async () => {
    const set = vi.fn(async () => "OK");
    const store = redisSnapshotStore(async () => ({
      get: async () => null,
      set,
    }));

    await store.write("k", "v", 30_000);

    expect(set).toHaveBeenCalledWith("k", "v", "PX", 30_000);
  });
});
