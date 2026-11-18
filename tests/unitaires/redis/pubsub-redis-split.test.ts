import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

/**
 * The pub/sub on a Redis of its own, or not (plano-escala F5-01).
 *
 * Without PUBSUB_REDIS_URL every pub/sub client is on REDIS_URL, exactly as
 * before: the adapter's channels, its URL and its connections do not move.
 * With it, the adapter's pair and the hints (the wake) all go to the
 * pub/sub's Redis together — an adapter on one Redis and a wake on another
 * would each hear half — while the counters stay where they were (the map
 * of every client is redis-role-map.test.ts).
 *
 * ioredis is replaced by a recorder: no Redis is reached, and the test
 * reads which URL each connection was opened on.
 */
const opened = vi.hoisted(
  () => [] as Array<{ url: string; name: string | undefined }>,
);

const clients = vi.hoisted(() => [] as unknown[]);

vi.mock("ioredis", async () => {
  const { EventEmitter: Emitter } = await import("node:events");

  class FakeRedis extends Emitter {
    status = "connecting";
    readonly subscribed: string[] = [];
    readonly published: Array<[string, string]> = [];

    constructor(url: string, options: { connectionName?: string } = {}) {
      super();
      opened.push({ url, name: options.connectionName });
      clients.push(this);
    }

    async publish(channel: string, message: string): Promise<number> {
      this.published.push([channel, message]);
      return 1;
    }

    async subscribe(channel: string): Promise<number> {
      this.subscribed.push(channel);
      return this.subscribed.length;
    }

    async unsubscribe(channel: string): Promise<number> {
      this.subscribed.splice(this.subscribed.indexOf(channel), 1);
      return this.subscribed.length;
    }

    async quit(): Promise<"OK"> {
      this.status = "end";
      return "OK";
    }
  }

  return { default: FakeRedis, Redis: FakeRedis };
});

const mutableEnv = env as unknown as {
  REDIS_URL: string;
  PUBSUB_REDIS_URL: string | undefined;
};
const original = { ...mutableEnv };

afterEach(async () => {
  const pubsub = await import("@/shared/redis/pubsub-redis");

  await pubsub.closePubSub();

  mutableEnv.REDIS_URL = original.REDIS_URL;
  mutableEnv.PUBSUB_REDIS_URL = original.PUBSUB_REDIS_URL;

  opened.length = 0;
  clients.length = 0;
});

describe("without PUBSUB_REDIS_URL", () => {
  it("opens every pub/sub connection on REDIS_URL, as before", async () => {
    mutableEnv.REDIS_URL = "redis://counters.example.com:6379";
    mutableEnv.PUBSUB_REDIS_URL = undefined;

    const pubsub = await import("@/shared/redis/pubsub-redis");

    pubsub.adapterClients(() => undefined);
    await pubsub.publisher().publish("k:wake:outbox", "r");
    pubsub.subscribe("k:wake:outbox", () => undefined);

    expect(opened.map(({ url }) => url)).toEqual([
      "redis://counters.example.com:6379",
      "redis://counters.example.com:6379",
      "redis://counters.example.com:6379",
      "redis://counters.example.com:6379",
    ]);
  });
});

describe("with PUBSUB_REDIS_URL", () => {
  it("moves the adapter and the hints together, and nothing else", async () => {
    mutableEnv.REDIS_URL = "redis://counters.example.com:6379";
    mutableEnv.PUBSUB_REDIS_URL = "redis://pubsub.example.com:6379";

    const pubsub = await import("@/shared/redis/pubsub-redis");

    const pair = pubsub.adapterClients(() => undefined);
    await pubsub.publisher().publish("k:wake:outbox", "r");
    pubsub.subscribe("k:wake:outbox", () => undefined);

    expect(pair.pub).toBeDefined();
    expect(new Set(opened.map(({ url }) => url))).toEqual(
      new Set(["redis://pubsub.example.com:6379"]),
    );
    expect(pubsub.pubsubRedisUrl()).toBe("redis://pubsub.example.com:6379");
  });
});

describe("the hints' subscriber", () => {
  it("is one connection, dispatches by channel and counts its generations", async () => {
    const pubsub = await import("@/shared/redis/pubsub-redis");

    const heard: string[] = [];

    const stop = pubsub.subscribe("k:wake:outbox", (message) =>
      heard.push(`outbox:${message}`),
    );
    pubsub.subscribe("k:wake:ai", (message) => heard.push(`ai:${message}`));

    expect(opened).toHaveLength(1);
    expect(pubsub.generation()).toBe(0);
    expect(pubsub.isReady()).toBe(false);

    const subscriber = clients[0] as EventEmitter & {
      status: string;
      subscribed: string[];
    };

    subscriber.status = "ready";
    subscriber.emit("ready");

    expect(pubsub.isReady()).toBe(true);
    expect(pubsub.generation()).toBe(1);

    subscriber.emit("message", "k:wake:outbox", "replica-a");
    subscriber.emit("message", "k:wake:jobs", "replica-a");

    expect(heard).toEqual(["outbox:replica-a"]);

    // A reconnect is a new generation: a listener knows it may have missed
    // hints in between.
    subscriber.emit("ready");
    expect(pubsub.generation()).toBe(2);

    stop();
    await Promise.resolve();
    expect(subscriber.subscribed).toEqual(["k:wake:ai"]);
  });

  it("survives a handler that throws", async () => {
    const pubsub = await import("@/shared/redis/pubsub-redis");

    const heard: string[] = [];

    pubsub.subscribe("k:wake:webhooks", () => {
      throw new Error("boom");
    });
    pubsub.subscribe("k:wake:webhooks", (message) => heard.push(message));

    (clients[0] as EventEmitter).emit("message", "k:wake:webhooks", "r");

    expect(heard).toEqual(["r"]);
  });
});
