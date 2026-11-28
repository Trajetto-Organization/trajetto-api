import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEAT_INTERVAL_MS,
  BEAT_JITTER_MS,
  LIVE_CONSUMERS_CACHE_MS,
  createFingerprintReader,
  createLiveConsumers,
  startProcessHeartbeat,
  type ProcessHeartbeatRow,
} from "@/shared/health/process-heartbeat";

/**
 * Every process's row in process_heartbeat (plano-escala F3-03), as the
 * process keeps it: the rules that do not need a database.
 *
 *  - the first beat at once, then every 30 s ± 5 s;
 *  - fail-open: a failed write is one warning, the process goes on, and
 *    the next beat tries again; a write still in flight skips a beat;
 *  - the row goes on stop, bounded, and no beat re-creates it after;
 *  - the fingerprint keeps the last identities while a server is away;
 *  - the live consumers are read once per 30 s, and a failed read keeps
 *    the last answer.
 */

afterEach(() => {
  vi.useRealTimers();
});

const ROW: Omit<ProcessHeartbeatRow, "config_fingerprint"> = {
  replica: "host-1",
  role: "worker",
  app_env: "staging",
  build_commit: "abc1234",
  node_hostname: null,
  queues: ["outbox", "internal"],
  cron: true,
  sockets: false,
  started_at: new Date("2026-11-18T10:00:00.000Z"),
};

function harness(overrides: {
  write?: (row: ProcessHeartbeatRow) => Promise<void>;
  remove?: (replica: string) => Promise<void>;
  random?: () => number;
}) {
  const writes: ProcessHeartbeatRow[] = [];
  const removed: string[] = [];

  const heartbeat = startProcessHeartbeat({
    row: () => ROW,
    fingerprint: async () => "0123456789abcdef",
    write:
      overrides.write ??
      (async (row) => {
        writes.push(row);
      }),
    remove:
      overrides.remove ??
      (async (replica) => {
        removed.push(replica);
      }),
    random: overrides.random ?? (() => 0.5),
  });

  return { heartbeat, writes, removed };
}

describe("the beats", () => {
  it("write the row at once, then every 30 s, with the fingerprint", async () => {
    vi.useFakeTimers();

    const { heartbeat, writes } = harness({});

    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      ...ROW,
      config_fingerprint: "0123456789abcdef",
    });

    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);
    expect(writes).toHaveLength(2);

    await heartbeat.stop();
  });

  it("land within the jitter around the interval", async () => {
    vi.useFakeTimers();

    // random() = 0: the earliest the next beat may come.
    const { heartbeat, writes } = harness({ random: () => 0 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS - BEAT_JITTER_MS - 1);
    expect(writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);

    await heartbeat.stop();
  });

  it("go on after a failed write, which never reaches the caller", async () => {
    vi.useFakeTimers();

    let fail = true;
    const writes: ProcessHeartbeatRow[] = [];

    const { heartbeat } = harness({
      write: async (row) => {
        if (fail) throw new Error("database away");
        writes.push(row);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(0);

    fail = false;
    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS);
    expect(writes).toHaveLength(1);

    await heartbeat.stop();
  });

  it("skip while a write hangs, instead of piling up", async () => {
    vi.useFakeTimers();

    let calls = 0;

    const { heartbeat } = harness({
      write: () => {
        calls += 1;
        return new Promise<void>(() => undefined);
      },
    });

    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * 3);
    expect(calls).toBe(1);

    const stopped = heartbeat.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
  });
});

describe("stopping", () => {
  it("deletes the row, once, and no beat brings it back", async () => {
    vi.useFakeTimers();

    const { heartbeat, writes, removed } = harness({});

    await vi.advanceTimersByTimeAsync(0);
    await heartbeat.stop();
    await heartbeat.stop();

    expect(removed).toEqual(["host-1"]);

    await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * 3);
    expect(writes).toHaveLength(1);
  });

  it("never hangs on a database that does not answer", async () => {
    vi.useFakeTimers();

    const { heartbeat } = harness({
      remove: () => new Promise<void>(() => undefined),
    });

    await vi.advanceTimersByTimeAsync(0);

    const stopped = heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(stopped).resolves.toBeUndefined();
  });
});

describe("the fingerprint's identities", () => {
  const COUNTERS = "run_id:0123456789abcdef0123456789abcdef01234567\r\n";
  const OTHER = "run_id:fedcba9876543210fedcba9876543210fedcba98\r\n";

  // Review of wave 12: the pub/sub moved to a Redis of its own on one
  // Application and not on the other gave both the same fingerprint, and
  // the deploy converged with their events and hints on two Redis servers.
  it("name the pub/sub's Redis, and tell two processes on two of them apart", async () => {
    const reader = (pubsubInfo?: () => Promise<string>) =>
      createFingerprintReader({
        databaseIdentity: async () => "7350000000000000001/trajetto",
        redisInfo: async () => COUNTERS,
        pubsubInfo,
      });

    const onCounters = await reader()();
    const onItsOwn = await reader(async () => OTHER)();

    expect(onCounters).toMatch(/^[0-9a-f]{16}$/);
    expect(onItsOwn).toMatch(/^[0-9a-f]{16}$/);
    expect(onItsOwn).not.toBe(onCounters);

    // The variable pointing at the counters' own server is the same Redis.
    expect(await reader(async () => COUNTERS)()).toBe(onCounters);
  });

  it("wait for the pub/sub's Redis too, then keep the last one read", async () => {
    let pubsubUp = false;

    const read = createFingerprintReader({
      databaseIdentity: async () => "7350000000000000001/trajetto",
      redisInfo: async () => COUNTERS,
      pubsubInfo: async () => {
        if (!pubsubUp) throw new Error("down");
        return OTHER;
      },
    });

    expect(await read()).toBeNull();

    pubsubUp = true;
    const known = await read();
    expect(known).toMatch(/^[0-9a-f]{16}$/);

    pubsubUp = false;
    expect(await read()).toBe(known);
  });

  it("are null until both were read, then the last ones read stand in", async () => {
    let databaseUp = false;
    let redisUp = true;

    const read = createFingerprintReader({
      databaseIdentity: async () => {
        if (!databaseUp) throw new Error("down");
        return "7350000000000000001/trajetto";
      },
      redisInfo: async () => {
        if (!redisUp) throw new Error("down");
        return "run_id:0123456789abcdef0123456789abcdef01234567\r\n";
      },
    });

    expect(await read()).toBeNull();

    databaseUp = true;
    const known = await read();
    expect(known).toMatch(/^[0-9a-f]{16}$/);

    // A Redis restarting does not flip the fingerprint of this beat.
    redisUp = false;
    expect(await read()).toBe(known);
  });
});

describe("the live consumers", () => {
  it("are read once per 30 s, per queue", async () => {
    let now = 0;
    const read = vi.fn(async () => new Map([["outbox", 2]]));
    const live = createLiveConsumers(read, () => now);

    expect(await live("outbox")).toBe(2);
    expect(await live("external")).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);

    now = LIVE_CONSUMERS_CACHE_MS;
    await live("outbox");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keep the last answer when a read fails, and say unknown before any", async () => {
    let now = 0;
    let fail = true;
    const live = createLiveConsumers(
      async () => {
        if (fail) throw new Error("down");
        return new Map([["webhooks", 1]]);
      },
      () => now,
    );

    expect(await live("webhooks")).toBeNull();

    fail = false;
    now = LIVE_CONSUMERS_CACHE_MS;
    expect(await live("webhooks")).toBe(1);

    fail = true;
    now = LIVE_CONSUMERS_CACHE_MS * 3;
    expect(await live("webhooks")).toBe(1);
  });
});
