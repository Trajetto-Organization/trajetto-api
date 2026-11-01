import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { Server as SocketIOServer } from "socket.io";

import { afterEach, describe, expect, it } from "vitest";

import { runShutdown } from "@/shared/lifecycle/shutdown";

/**
 * The `ws` package socket.io itself depends on. Typed here by hand: the API
 * has no direct dependency on it, and a type package for one test is not
 * worth a new devDependency.
 */
interface RawWebSocket {
  once(event: "open" | "error", listener: (error?: Error) => void): void;
  terminate(): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require("ws") as new (url: string) => RawWebSocket;

/**
 * A replica going away must finish what it has and hand its clients over —
 * not be cut off mid-send.
 *
 * Before: every deploy ended in SIGKILL. Yarn was the container's long-lived
 * process and exits 1 on SIGTERM, so Node never finished shutting down; and
 * even with the signal delivered, `app.close()` waited forever on the open
 * websockets, until the watchdog killed the process with the workers still
 * claiming work. Deliveries already accepted by a provider but not yet marked
 * came back after the lease as duplicates.
 */

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

/** A Fastify server with Socket.IO attached and one websocket client on it. */
async function serverWithConnectedClient(): Promise<{
  app: FastifyInstance;
  io: SocketIOServer;
}> {
  const app = fastify();
  await app.listen({ host: "127.0.0.1", port: 0 });

  const io = new SocketIOServer(app.server);
  const { port } = app.server.address() as AddressInfo;

  // The raw engine.io websocket: what a phone or a browser tab holds open
  // all day. Enough to keep the HTTP server from closing.
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
  );

  cleanup.push(() => client.terminate());

  await new Promise<void>((resolveOpen, reject) => {
    client.once("open", () => resolveOpen());
    client.once("error", reject);
  });

  return { app, io };
}

function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolveLate) =>
      setTimeout(() => resolveLate(false), ms),
    ),
  ]);
}

describe("graceful shutdown sequence", () => {
  it("drains, then closes realtime, then HTTP, then workers, then Redis", async () => {
    const calls: string[] = [];

    await runShutdown(
      {
        markDraining: () => calls.push("drain"),
        drainMs: 12_000,
        drainImports: async () => {
          calls.push("imports");
        },
        closeRealtime: () => calls.push("realtime"),
        closeHttp: async () => {
          calls.push("http");
        },
        stopWorkers: async () => {
          calls.push("workers");
        },
        closeRedis: async () => {
          calls.push("redis");
        },
      },
      async (ms) => {
        calls.push(`wait:${ms}`);
      },
    );

    expect(calls).toEqual([
      "drain",
      "imports",
      "wait:12000",
      "realtime",
      "http",
      "workers",
      "redis",
    ]);
  });

  it("starts the import queue's drain with readiness, and waits for it before the workers", async () => {
    const calls: string[] = [];

    let finishImports!: () => void;
    const importsDone = new Promise<void>((resolve) => {
      finishImports = resolve;
    });

    const shutdown = runShutdown(
      {
        markDraining: () => calls.push("drain"),
        drainMs: 12_000,
        drainImports: async () => {
          calls.push("imports:start");
          await importsDone;
          calls.push("imports:done");
        },
        closeRealtime: () => calls.push("realtime"),
        closeHttp: async () => {
          calls.push("http");
        },
        stopWorkers: async () => {
          calls.push("workers");
        },
        closeRedis: async () => {
          calls.push("redis");
        },
      },
      async (ms) => {
        calls.push(`wait:${ms}`);
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    // The running upload still has the drain window: HTTP is closed, the
    // workers are not stopped yet.
    expect(calls).toEqual([
      "drain",
      "imports:start",
      "wait:12000",
      "realtime",
      "http",
    ]);

    finishImports();
    await shutdown;

    expect(calls.slice(5)).toEqual(["imports:done", "workers", "redis"]);
  });

  it("still stops the workers when the import drain fails", async () => {
    const calls: string[] = [];

    await runShutdown({
      markDraining: () => undefined,
      drainMs: 0,
      drainImports: async () => {
        throw new Error("database unavailable");
      },
      closeRealtime: () => undefined,
      closeHttp: async () => undefined,
      stopWorkers: async () => {
        calls.push("workers");
      },
      closeRedis: async () => {
        calls.push("redis");
      },
    });

    expect(calls).toEqual(["workers", "redis"]);
  });

  it("does not wait when there is nothing polling readiness", async () => {
    const waits: number[] = [];

    await runShutdown(
      {
        markDraining: () => undefined,
        drainMs: 0,
        drainImports: async () => undefined,
        closeRealtime: () => undefined,
        closeHttp: async () => undefined,
        stopWorkers: async () => undefined,
        closeRedis: async () => undefined,
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(waits).toEqual([]);
  });
});

describe("closing the HTTP server with websockets open", () => {
  it("hangs when the Socket.IO engine is left open (the old order)", async () => {
    const { app, io } = await serverWithConnectedClient();

    const closing = app.close();

    // Still pending well after a normal close takes milliseconds: this is
    // the hang the watchdog used to cut with exit(1).
    expect(await settlesWithin(closing, 1_500)).toBe(false);

    io.engine.close();
    await closing;
  });

  it("closes promptly through the shutdown sequence", async () => {
    const { app, io } = await serverWithConnectedClient();

    const started = Date.now();

    await runShutdown({
      markDraining: () => undefined,
      drainMs: 0,
      drainImports: async () => undefined,
      closeRealtime: () => io.engine.close(),
      closeHttp: () => app.close(),
      stopWorkers: async () => undefined,
      closeRedis: async () => undefined,
    });

    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("the container's long-lived process", () => {
  const root = resolve(__dirname, "..", "..", "..");

  it("is Node, exec'ed by the entrypoint, never Yarn", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const entrypoint = readFileSync(
      resolve(root, "infra", "scripts", "docker-entrypoint.sh"),
      "utf8",
    );

    // The API image's stage: the release image after it has a CMD of its
    // own (`migrate`), which never serves.
    const runner = dockerfile.slice(
      dockerfile.indexOf("FROM base AS runner"),
      dockerfile.indexOf("FROM runner AS migrate"),
    );
    const cmd = runner
      .split(/\r?\n/)
      .filter((line) => line.startsWith("CMD "))
      .pop();

    // Yarn Classic exits 1 on SIGTERM and takes the container with it.
    expect(cmd).toBe('CMD ["./docker-entrypoint.sh"]');

    const commands = entrypoint
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(commands[commands.length - 1]).toBe("exec node build/server.js");
    // No package-manager wrapper anywhere in what the script RUNS (its
    // comments may explain why).
    for (const command of commands) {
      expect(command).not.toMatch(/\byarn\b|\bnpm run\b|\brun-s\b/);
    }
  });
});
