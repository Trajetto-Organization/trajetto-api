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

  // The adapter subscribes on construction; give Redis the round trip.
  await new Promise((done) => setTimeout(done, 300));

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

/** Whether a server-side emit from `from` reaches `to` within a moment. */
function crosses(from: Node, to: Node): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), 700);

    to.io.on("isolation-probe", () => {
      clearTimeout(timer);
      done(true);
    });

    from.io.serverSideEmit("isolation-probe");
  });
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((each) => each.close()));
});

describe("two adapters on one Redis", () => {
  it("hear each other across database numbers — the number isolates nothing", async () => {
    const key = `socket.io-isolation-${randomUUID()}`;

    const a = await node(onDatabase(0), key);
    const b = await node(onDatabase(7), key);

    expect(await crosses(a, b)).toBe(true);
  });

  it("do not hear each other under different prefixes", async () => {
    const a = await node(BASE, `socket.io-isolation-${randomUUID()}`);
    const b = await node(BASE, `socket.io-isolation-${randomUUID()}`);

    expect(await crosses(a, b)).toBe(false);
  });
});
