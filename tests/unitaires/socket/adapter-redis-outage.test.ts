import net from "node:net";

import Redis from "ioredis";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

import { afterEach, describe, expect, it } from "vitest";

import { redisClientOptions } from "@/config/redis-client-options";
import {
  createAdapterRedisClients,
  waitForAdapterRedis,
} from "@/shared/socket/adapter-redis";

/**
 * Redis going away must cost realtime frames, never the process.
 *
 * Before: a Redis restart took every API replica down within a second. The
 * Socket.IO adapter publishes without handling the promise, the publish sat in
 * ioredis' offline queue, was rejected with MaxRetriesPerRequestError, and on
 * Node 22 that unhandled rejection exits the process. The boot, meanwhile,
 * refused to start at all without Redis in production.
 *
 * A fake Redis speaking just enough RESP stands in for the real one, so the
 * outage can be switched on and off inside a unit test.
 */

interface FakeRedis {
  url: string;
  /** Drops every connection and stops listening: Redis is gone. */
  kill: () => Promise<void>;
  /** Keeps connections open but stops answering: Redis is hung. */
  hang: () => void;
}

function parseCommands(buffer: Buffer): string[][] {
  const text = buffer.toString("latin1");
  const commands: string[][] = [];
  let index = 0;

  while (index < text.length && text[index] === "*") {
    let end = text.indexOf("\r\n", index);
    const count = Number(text.slice(index + 1, end));
    index = end + 2;

    const args: string[] = [];

    for (let arg = 0; arg < count; arg += 1) {
      end = text.indexOf("\r\n", index);
      const length = Number(text.slice(index + 1, end));
      index = end + 2;
      args.push(text.slice(index, index + length));
      index += length + 2;
    }

    commands.push(args);
  }

  return commands;
}

const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;

async function startFakeRedis(): Promise<FakeRedis> {
  const sockets = new Set<net.Socket>();
  let hung = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);

    socket.on("data", (data: Buffer) => {
      if (hung) return;

      for (const args of parseCommands(data)) {
        const command = args[0].toUpperCase();

        if (command === "INFO") {
          socket.write(bulk("# Server\r\nredis_version:7.2.0\r\nloading:0\r\n"));
        } else if (command === "SUBSCRIBE" || command === "PSUBSCRIBE") {
          args.slice(1).forEach((channel, position) =>
            socket.write(
              `*3\r\n${bulk(command.toLowerCase())}${bulk(channel)}:${position + 1}\r\n`,
            ),
          );
        } else if (command === "PUBLISH" || command === "INCR") {
          socket.write(":1\r\n");
        } else if (command === "PUBSUB") {
          socket.write("*2\r\n" + bulk(args[2] ?? "") + ":1\r\n");
        } else {
          socket.write("+OK\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as net.AddressInfo;

  return {
    url: `redis://127.0.0.1:${port}`,
    kill: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
    hang: () => {
      hung = true;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe("Socket.IO adapter while Redis is unavailable", () => {
  it("absorbs every failed publish instead of leaving it unhandled", async () => {
    const fake = await startFakeRedis();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    cleanup.push(() => process.off("unhandledRejection", onUnhandled));

    const failures: unknown[] = [];
    const clients = createAdapterRedisClients(fake.url, (error) =>
      failures.push(error),
    );

    // Same as attachRedisConnectionLog does in production: without a
    // listener, ioredis' `error` event would be the crash instead.
    clients.pub.on("error", () => undefined);
    clients.sub.on("error", () => undefined);

    cleanup.push(() => {
      clients.pub.disconnect();
      clients.sub.disconnect();
    });

    expect(await waitForAdapterRedis(clients, 2_000)).toBe(true);

    const io = new SocketIOServer();
    io.adapter(createAdapter(clients.pub, clients.sub));
    // No HTTP server is attached, so `io.close()` has nothing to close; the
    // adapter is what holds the subscriptions.
    cleanup.push(() =>
      (io.of("/").adapter as unknown as { close?: () => unknown }).close?.(),
    );

    io.to("operations:x").emit("driverPosition", { ok: true });

    await fake.kill();

    // The hot path during an outage: positions keep arriving and keep being
    // broadcast. Each of these used to end in an unhandled rejection.
    for (let frame = 0; frame < 10; frame += 1) {
      io.to("operations:x").emit("driverPosition", { frame });
      await sleep(50);
    }

    // Longer than the ~0.3s the old configuration needed to reject.
    await sleep(1_500);

    expect(unhandled).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("does not block the boot when Redis is not there", async () => {
    // A port nothing listens on.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const clients = createAdapterRedisClients(
      `redis://127.0.0.1:${port}`,
      () => undefined,
    );

    clients.pub.on("error", () => undefined);
    clients.sub.on("error", () => undefined);

    cleanup.push(() => {
      clients.pub.disconnect();
      clients.sub.disconnect();
    });

    const started = Date.now();
    const ready = await waitForAdapterRedis(clients, 500);

    // Resolves — never rejects — within its budget, so the caller logs a
    // degraded realtime and keeps booting.
    expect(ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("counters in the request path while Redis is hung", () => {
  it("gives up on a rate-limit counter within its command timeout", async () => {
    const fake = await startFakeRedis();

    const client = new Redis(fake.url, redisClientOptions("rate-limit"));
    client.on("error", () => undefined);
    cleanup.push(() => client.disconnect());
    cleanup.push(() => fake.kill());

    await new Promise<void>((resolve) => client.once("ready", () => resolve()));

    // Accepts the TCP connection, never answers: a paused container, a full
    // disk. Every HTTP request consults this counter before its handler runs,
    // and it used to wait for the answer forever.
    fake.hang();

    const started = Date.now();

    await expect(client.incr("rl:probe")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps the request-path clients free of an offline queue", () => {
    for (const role of ["rate-limit", "socket-handshake"] as const) {
      const options = redisClientOptions(role);

      expect(options.enableOfflineQueue).toBe(false);
      expect(options.commandTimeout).toBeGreaterThan(0);
      expect(options.commandTimeout).toBeLessThanOrEqual(1_000);
    }
  });

  it("lets the subscriber wait for Redis however long it takes", () => {
    const options = redisClientOptions("socket-sub");

    // A subscribe that gave up would leave the replica deaf for good.
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.commandTimeout).toBeUndefined();
  });
});
