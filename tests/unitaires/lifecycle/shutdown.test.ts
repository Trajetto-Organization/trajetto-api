import { readFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { Server as SocketIOServer } from "socket.io";

import { afterEach, describe, expect, it } from "vitest";

import { markDraining } from "@/shared/lifecycle/draining";
import { runShutdown } from "@/shared/lifecycle/shutdown";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

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
        httpMs: 10_000,
        cutHttp: () => calls.push("cut"),
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

  /**
   * The GPS group commit (plano-escala F5-19): a request in flight waits
   * for the batch its points are in. The buffer is written out as HTTP
   * closes, and finished before the workers stop and Redis goes, so the
   * request is answered with its points committed.
   */
  it("writes the group commit's flushes as HTTP closes, before the workers stop", async () => {
    const calls: string[] = [];
    let releaseHttp: () => void = () => undefined;

    await runShutdown(
      {
        markDraining: () => calls.push("drain"),
        drainMs: 0,
        drainImports: async () => undefined,
        closeRealtime: () => calls.push("realtime"),
        closeHttp: () =>
          new Promise<void>((resolveHttp) => {
            calls.push("http");
            releaseHttp = resolveHttp;
          }),
        drainWrites: async () => {
          calls.push("writes");
          // The request waiting on the batch is answered now.
          releaseHttp();
          calls.push("writes:done");
        },
        httpMs: 10_000,
        cutHttp: () => calls.push("cut"),
        stopWorkers: async () => {
          calls.push("workers");
        },
        closeRedis: async () => {
          calls.push("redis");
        },
      },
      async () => undefined,
    );

    expect(calls).toEqual([
      "drain",
      "realtime",
      "http",
      "writes",
      "writes:done",
      "workers",
      "redis",
    ]);
  });

  /**
   * The sockets in slices over the drain (plano-escala U-01): started with
   * it, over its whole window, before the wait, so the reconnections reach
   * the other replicas spread instead of all in the same second.
   */
  it("spreads the realtime close over the drain, then ends the rest", async () => {
    const calls: string[] = [];

    await runShutdown(
      {
        markDraining: () => calls.push("drain"),
        drainMs: 12_000,
        drainImports: async () => {
          calls.push("imports");
        },
        spreadRealtime: (windowMs) => calls.push(`spread:${windowMs}`),
        closeRealtime: () => calls.push("realtime"),
        closeHttp: async () => {
          calls.push("http");
        },
        httpMs: 10_000,
        cutHttp: () => calls.push("cut"),
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
      "spread:12000",
      "wait:12000",
      "realtime",
      "http",
      "workers",
      "redis",
    ]);
  });

  it("does not spread with no drain, and a spread that throws stops nothing", async () => {
    const withoutDrain: string[] = [];
    const steps = (calls: string[], drainMs: number) => ({
      markDraining: () => calls.push("drain"),
      drainMs,
      drainImports: async () => undefined,
      spreadRealtime: () => {
        calls.push("spread");
        throw new Error("sem io");
      },
      closeRealtime: () => calls.push("realtime"),
      closeHttp: async () => undefined,
      httpMs: 10_000,
      cutHttp: () => undefined,
      stopWorkers: async () => undefined,
      closeRedis: async () => {
        calls.push("redis");
      },
    });

    await runShutdown(steps(withoutDrain, 0), async () => undefined);

    expect(withoutDrain).toEqual(["drain", "realtime", "redis"]);

    const throwing: string[] = [];

    await runShutdown(steps(throwing, 3_000), async () => undefined);

    expect(throwing).toEqual(["drain", "spread", "realtime", "redis"]);
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
        httpMs: 10_000,
        cutHttp: () => calls.push("cut"),
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
      httpMs: 10_000,
      cutHttp: () => undefined,
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
        httpMs: 10_000,
        cutHttp: () => undefined,
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
      httpMs: 10_000,
      cutHttp: () => app.server.closeAllConnections(),
      stopWorkers: async () => undefined,
      closeRedis: async () => undefined,
    });

    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

/** What one request ended with: its status and body, or its socket error. */
interface Outcome {
  status?: number;
  body?: string;
  error?: string;
}

/** A GET on a connection of its own, settled however it ends. */
function outcomeOf(port: number, path: string): Promise<Outcome> {
  return new Promise((resolveOutcome) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, agent: false },
      (res) => {
        let body = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.once("end", () => resolveOutcome({ status: res.statusCode, body }));
        res.once("error", (error) => resolveOutcome({ error: error.message }));
      },
    );

    req.once("error", (error) => resolveOutcome({ error: error.message }));
    req.end();
  });
}

/** A server whose route answers when the test says so, or never. */
async function serverWithSlowRoute(answerAfterMs: number | null): Promise<{
  app: FastifyInstance;
  port: number;
  arrived: Promise<void>;
}> {
  const app = fastify();

  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });

  let arrive!: () => void;
  const arrived = new Promise<void>((resolveArrive) => {
    arrive = resolveArrive;
  });

  app.get("/slow", async () => {
    arrive();

    if (answerAfterMs === null) await released;
    else
      await new Promise((resolveLater) =>
        setTimeout(resolveLater, answerAfterMs),
      );

    return "done";
  });

  await app.listen({ host: "127.0.0.1", port: 0 });

  // A handler left waiting must not outlive the test.
  cleanup.push(async () => {
    release();
    await app.close();
  });

  return { app, port: (app.server.address() as AddressInfo).port, arrived };
}

/**
 * A request still in flight when the drain ends no longer holds the
 * workers back (plano-escala F1-14).
 *
 * `app.close()` waits for every request in flight and has no deadline of
 * its own; the body may take up to 120 s (HTTP_REQUEST_TIMEOUT_MS). An old
 * app build sending a photo through the multipart adapter on a slow 3G link
 * held the close past the plan, the watchdog's exit(1) came before the
 * workers stopped, a cron run was left RUNNING for the sweep to write off as
 * FAILED and the notification and webhook batches fell back to their leases.
 * The requests now get the plan's `httpMs`, then their connections are
 * closed — they were lost to the watchdog anyway — and the workers stop
 * inside the grace.
 */
describe("a request still in flight when the drain ends", () => {
  it("is cut at the plan's HTTP deadline, and the workers still stop", async () => {
    const { app, port, arrived } = await serverWithSlowRoute(null);
    const calls: string[] = [];

    const outcome = outcomeOf(port, "/slow");
    await arrived;

    const shutdown = runShutdown({
      markDraining: () => undefined,
      drainMs: 0,
      drainImports: async () => undefined,
      closeRealtime: () => undefined,
      closeHttp: () => app.close(),
      httpMs: 300,
      cutHttp: () => {
        calls.push("cut");
        app.server.closeAllConnections();
      },
      stopWorkers: async () => {
        calls.push("workers");
      },
      closeRedis: async () => {
        calls.push("redis");
      },
    });

    expect(await settlesWithin(shutdown, 2_000)).toBe(true);
    expect(calls).toEqual(["cut", "workers", "redis"]);

    // The client learns its request did not complete, and retries it.
    expect((await outcome).error).toBeDefined();
  });

  it("lets a request that ends within the deadline finish, untouched", async () => {
    const { app, port, arrived } = await serverWithSlowRoute(200);
    const calls: string[] = [];

    const outcome = outcomeOf(port, "/slow");
    await arrived;

    await runShutdown({
      markDraining: () => undefined,
      drainMs: 0,
      drainImports: async () => undefined,
      closeRealtime: () => undefined,
      closeHttp: () => app.close(),
      httpMs: 5_000,
      cutHttp: () => {
        calls.push("cut");
        app.server.closeAllConnections();
      },
      stopWorkers: async () => {
        calls.push("workers");
      },
      closeRedis: async () => undefined,
    });

    expect(calls).toEqual(["workers"]);
    expect(await outcome).toEqual({ status: 200, body: "done" });
  });
});

/** One GET on the agent's connection: its Connection header and its socket. */
function get(
  port: number,
  agent: Agent,
): Promise<{ connection: string | undefined; socket: Socket }> {
  return new Promise((resolveGet, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health/liveness", agent },
      (res) => {
        res.resume();
        res.once("end", () =>
          resolveGet({
            connection: res.headers.connection,
            socket: req.socket as Socket,
          }),
        );
      },
    );

    req.once("error", reject);
    req.end();
  });
}

/**
 * The drain must empty the replica, not just wait (plano-escala F1-15).
 *
 * The Swarm takes a stopping task out of the service's address before the
 * SIGTERM, so new connections go to another replica. The keep-alive ones
 * Traefik already holds with this task do not move: they kept carrying
 * requests through the whole drain, and the listener closed under them. Now
 * every response sent while draining says `Connection: close`, and the
 * replica ends that connection after it; Traefik opens the next one
 * elsewhere. Idle connections are not closed in a loop: one closed while
 * Traefik writes a POST on it is a 502, which Go never retries.
 */
describe("a draining replica, through the real server", () => {
  it(
    "answers with Connection: close and ends the connection, so the listener closes at once",
    async () => {
      const { app } = await import("@/http");
      await app.listen({ host: "127.0.0.1", port: 0 });

      const { port } = app.server.address() as AddressInfo;
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });

      cleanup.push(() => agent.destroy());

      // Before SIGTERM: a kept-alive connection, as Traefik holds them.
      const before = await get(port, agent);
      expect(before.connection).toBe("keep-alive");

      let endDrain!: () => void;
      const drainWindow = new Promise<void>((resolveDrain) => {
        endDrain = resolveDrain;
      });

      const shutdown = runShutdown(
        {
          markDraining,
          drainMs: 12_000,
          drainImports: async () => undefined,
          closeRealtime: () => undefined,
          closeHttp: () => app.close(),
          httpMs: 10_000,
          cutHttp: () => app.server.closeAllConnections(),
          stopWorkers: async () => undefined,
          closeRedis: async () => undefined,
        },
        () => drainWindow,
      );

      // During the drain, on the same connection.
      const during = await get(port, agent);

      expect(during.socket).toBe(before.socket);
      expect(during.connection).toBe("close");

      if (!during.socket.destroyed) {
        await new Promise<void>((closed) =>
          during.socket.once("close", () => closed()),
        );
      }

      // Nothing kept alive is left: the listener closes without waiting
      // for Traefik to give up on an idle connection.
      endDrain();

      const started = Date.now();
      await shutdown;

      expect(Date.now() - started).toBeLessThan(1_500);
    },
    APP_BOOT_TIMEOUT_MS,
  );
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
