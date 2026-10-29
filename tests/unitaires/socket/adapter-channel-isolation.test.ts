import { randomUUID } from "node:crypto";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";

import { socketAdapterOptions } from "@/shared/socket/adapter-redis";

/**
 * What actually keeps two stacks on one Redis from hearing each other.
 *
 * The multi-replica suite pointed its replicas at `redis://…/7` "to separate
 * the channels" — but Pub/Sub has nothing to do with the keyspace: a publish
 * on database 7 reaches subscribers on database 0. Two environments sharing a
 * Redis with different database numbers would have had their realtime
 * crossed. The adapter's channel prefix is the only separation there is.
 */
const BASE = process.env.REDIS_URL ?? "redis://localhost:6379";

function onDatabase(db: number): string {
  const url = new URL(BASE);
  url.pathname = `/${db}`;
  return url.toString();
}

interface Node {
  io: Server;
  close: () => Promise<void>;
}

const nodes: Node[] = [];

/** Adapters created per key so far: the subscribers Redis must report. */
const listeners = new Map<string, number>();

/**
 * Waits until Redis reports `count` subscribers on `channel`.
 *
 * The adapter subscribes on construction without handing back the promise.
 * A fixed pause for that round trip was too short on a loaded machine (CI or
 * a full coverage run): the probe went out before the SUBSCRIBE landed and
 * the cross-database case failed although the channels do cross. Pub/Sub is
 * global, so NUMSUB counts the subscribers of every database number.
 */
async function untilSubscribed(
  client: Redis,
  channel: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    const [, subscribers] = (await client.pubsub("NUMSUB", channel)) as [
      string,
      number,
    ];

    if (Number(subscribers) >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`no subscription on ${channel}`);
    }

    await new Promise((done) => setTimeout(done, 25));
  }
}

async function node(url: string, key: string): Promise<Node> {
  const pub = new Redis(url, { maxRetriesPerRequest: 1 });
  const sub = new Redis(url, { maxRetriesPerRequest: 1 });

  const io = new Server({
    adapter: createAdapter(
      pub,
      sub,
      socketAdapterOptions({ SOCKET_ADAPTER_KEY: key }),
    ),
  });

  // serverSideEmit travels on the request channel.
  const { requestChannel } = io.of("/").adapter as unknown as {
    requestChannel: string;
  };
  const expected = (listeners.get(key) ?? 0) + 1;

  listeners.set(key, expected);
  await untilSubscribed(pub, requestChannel, expected);

  const created = {
    io,
    // Not attached to an HTTP server, so there is no engine to close: only
    // the adapter's subscriptions and the two connections.
    close: async () => {
      await (io.of("/").adapter as { close?: () => unknown }).close?.();
      await pub.quit();
      await sub.quit();
    },
  };

  nodes.push(created);
  return created;
}

/** Whether a server-side emit from `from` reaches `to` within `ms`. */
function crosses(from: Node, to: Node, ms = 700): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);

    to.io.on("isolation-probe", () => {
      clearTimeout(timer);
      done(true);
    });

    from.io.serverSideEmit("isolation-probe");
  });
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((each) => each.close()));
  listeners.clear();
});

describe("two adapters on one Redis", () => {
  it("hear each other across database numbers — the number isolates nothing", async () => {
    const key = `socket.io-isolation-${randomUUID()}`;

    const a = await node(onDatabase(0), key);
    const b = await node(onDatabase(7), key);

    // Both are subscribed by now, so this waits only for the delivery; the
    // longer bound is for a loaded machine and ends at the first frame.
    expect(await crosses(a, b, 3_000)).toBe(true);
  }, 15_000);

  it("do not hear each other under different prefixes", async () => {
    const a = await node(BASE, `socket.io-isolation-${randomUUID()}`);
    const b = await node(BASE, `socket.io-isolation-${randomUUID()}`);

    expect(await crosses(a, b)).toBe(false);
  }, 15_000);
});
