import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WAKE_DEBOUNCE_MS,
  createWakeBus,
  parseWakeMessage,
  shouldPublish,
  wakeChannel,
  type WakeBusDeps,
} from "@/shared/wake/wake-bus";
import { startWakeListener } from "@/shared/wake/wake-listener";
import type { ProcessRole, WorkerQueue } from "@/shared/lifecycle/process-role";

/**
 * The wake between processes (plano-escala F3-04).
 *
 * Once the api publishes and a worker drains, a publish on the api woke
 * nobody and the bell waited for the worker's sweep. The process that
 * enqueued now says so on Redis; the processes that claim the queue wake.
 * What this pins, without a Redis (the E2E of replicas has the real one):
 *
 *  - who publishes: a process that does not claim the queue, or one of
 *    several live consumers; never the `all` role, today's production;
 *  - a burst is one PUBLISH per queue per 100 ms, carrying the replica and
 *    the version and nothing else;
 *  - the channel stays out of the Socket.IO adapter's patterns;
 *  - the listener wakes only the queues it claims, never on its own hint,
 *    and every queue once after a reconnect.
 */

afterEach(() => {
  vi.useRealTimers();
});

function deps(overrides: Partial<WakeBusDeps> = {}) {
  const published: Array<[string, string]> = [];

  const bus = createWakeBus({
    role: () => "api",
    consumes: () => false,
    liveConsumers: async () => 1,
    publish: async (channel, message) => {
      published.push([channel, message]);
    },
    channel: (queue) => wakeChannel(queue, "socket.io"),
    replica: () => "api-1",
    ...overrides,
  });

  return { bus, published };
}

describe("who publishes", () => {
  const rule = (role: ProcessRole, consumes: boolean, live: number | null) =>
    shouldPublish("outbox", {
      role: () => role,
      consumes: () => consumes,
      liveConsumers: async () => live,
    });

  it("a process that does not claim the queue, whatever the count", async () => {
    expect(await rule("api", false, 0)).toBe(true);
    expect(await rule("api", false, null)).toBe(true);
  });

  it("never the all role, which claims everything and woke itself", async () => {
    expect(await rule("all", true, 2)).toBe(false);
    expect(await rule("all", true, null)).toBe(false);
  });

  it("a worker only when another live consumer can help, or the count is unknown", async () => {
    expect(await rule("worker", true, 1)).toBe(false);
    expect(await rule("worker", true, 2)).toBe(true);
    expect(await rule("worker", true, null)).toBe(true);
  });

  it("an all process whose WORKER_QUEUES leaves the queue out", async () => {
    expect(await rule("all", false, 1)).toBe(true);
  });
});

describe("the hint", () => {
  it("is one PUBLISH per queue per 100 ms, with the replica and the version only", async () => {
    vi.useFakeTimers();

    const { bus, published } = deps();

    for (let i = 0; i < 50; i += 1) bus.announce("outbox");
    bus.announce("ai");

    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    expect(published).toEqual([
      ["socket.io:wake:outbox", JSON.stringify({ v: 1, replica: "api-1" })],
      ["socket.io:wake:ai", JSON.stringify({ v: 1, replica: "api-1" })],
    ]);

    // The next burst is the next hint.
    bus.announce("outbox");
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(published).toHaveLength(3);
  });

  it("is not published at all by the all role (0 PUBLISH)", async () => {
    vi.useFakeTimers();

    const { bus, published } = deps({
      role: () => "all",
      consumes: () => true,
      liveConsumers: async () => 2,
    });

    bus.announce("outbox");
    bus.announce("webhooks");
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2);

    expect(published).toEqual([]);
  });

  it("never throws at the caller when Redis is away", async () => {
    vi.useFakeTimers();

    const { bus } = deps({
      publish: async () => {
        throw new Error("Redis away");
      },
    });

    expect(() => bus.announce("outbox")).not.toThrow();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  });

  it("is dropped on stop, before its debounce ends", async () => {
    vi.useFakeTimers();

    const { bus, published } = deps();

    bus.announce("outbox");
    bus.stop();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2);

    expect(published).toEqual([]);
  });

  it("is read back as published, and anything else on the channel is ignored", () => {
    expect(parseWakeMessage(JSON.stringify({ v: 1, replica: "a" }))).toEqual({
      v: 1,
      replica: "a",
    });
    expect(parseWakeMessage(JSON.stringify({ v: 2, replica: "a" }))).toEqual({
      v: 2,
      replica: "a",
    });
    expect(parseWakeMessage("not json")).toBeNull();
    expect(parseWakeMessage(JSON.stringify({ replica: "a" }))).toBeNull();
  });
});

describe("the channel", () => {
  it("is out of the Socket.IO adapter's patterns", () => {
    // @socket.io/redis-adapter 8 PSUBSCRIBEs `<key>#*` and SUBSCRIBEs
    // `<key>-request#/#` and `<key>-response#…`: a hint on any of them would
    // be parsed by the adapter of every replica.
    for (const queue of [
      "outbox",
      "internal",
      "external",
      "webhooks",
      "ai",
      "jobs",
    ] as WorkerQueue[]) {
      const channel = wakeChannel(queue, "socket.io");

      expect(channel).toBe(`socket.io:wake:${queue}`);
      expect(channel.startsWith("socket.io#")).toBe(false);
      expect(channel.startsWith("socket.io-request#")).toBe(false);
      expect(channel.startsWith("socket.io-response#")).toBe(false);
    }
  });
});

describe("the listener", () => {
  function listener(options: { consumes: WorkerQueue[] }) {
    const handlers = new Map<string, (message: string) => void>();
    const unsubscribed: string[] = [];
    let generation = 0;
    const woken: string[] = [];

    const stop = startWakeListener(
      {
        outbox: () => woken.push("outbox"),
        external: () => woken.push("external"),
        ai: () => woken.push("ai"),
      },
      {
        consumes: (queue) => options.consumes.includes(queue),
        listen: (channel, handler) => {
          handlers.set(channel, handler);
          return () => unsubscribed.push(channel);
        },
        generation: () => generation,
        channel: (queue) => wakeChannel(queue, "k"),
        replica: () => "worker-1",
        checkEveryMs: 1_000,
      },
    );

    return {
      stop,
      woken,
      unsubscribed,
      handlers,
      hint: (queue: string, replica: string) =>
        handlers.get(`k:wake:${queue}`)?.(JSON.stringify({ v: 1, replica })),
      reconnect: () => {
        generation += 1;
      },
    };
  }

  it("subscribes only the queues it claims and has a worker for", () => {
    const { handlers, stop } = listener({
      consumes: ["outbox", "webhooks", "ai"],
    });

    expect([...handlers.keys()].sort()).toEqual(["k:wake:ai", "k:wake:outbox"]);

    stop();
  });

  it("wakes on another process's hint, never on its own", () => {
    const { hint, woken, stop } = listener({ consumes: ["outbox", "ai"] });

    hint("outbox", "api-1");
    hint("outbox", "worker-1");
    hint("ai", "api-2");

    expect(woken).toEqual(["outbox", "ai"]);

    stop();
  });

  it("wakes every queue once after a reconnect, not after the first connection", async () => {
    vi.useFakeTimers();

    const { reconnect, woken, stop } = listener({
      consumes: ["outbox", "external"],
    });

    // The first connection: nothing was missed before it.
    reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(woken).toEqual([]);

    reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(woken).toEqual(["outbox", "external"]);

    stop();
  });

  it("unsubscribes on stop", () => {
    const { stop, unsubscribed } = listener({ consumes: ["outbox"] });

    stop();

    expect(unsubscribed).toEqual(["k:wake:outbox"]);
  });
});
