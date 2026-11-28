import { readdirSync, readFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join, resolve } from "node:path";

import type { RateLimitPluginOptions } from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * This file's app keeps its rate limiter to itself.
 *
 * The cap test below sends a thousand requests from 127.0.0.1 on one
 * socket. Through the real limiter they were all charged to
 * `fastify-rate-limit-ip:127.0.0.1`, in the Redis that every test process
 * of the run shares: that key sat at 1 000 for a minute, and any other file
 * that injected an anonymous request in that minute (inject also comes from
 * 127.0.0.1) was answered 429. retired-routes.test.ts failed that way in
 * the Unit tests step of the wave 2 replica.
 *
 * The limiter is not what this file tests. Here it keeps its counts in this
 * process (no `redis`) and lets every request through, so the thousand
 * requests are ordinary 200s and nothing lands in Redis; the rest is the
 * app as it boots. The limiter's own behaviour is tested by
 * tests/E2E/http-rate-limit.test.ts and its neighbours, each from addresses
 * of its own.
 */
vi.mock("@fastify/rate-limit", async (importOriginal) => {
  const { default: rateLimit } = await importOriginal<{
    default: FastifyPluginAsync<RateLimitPluginOptions>;
  }>();

  const isolated: FastifyPluginAsync<RateLimitPluginOptions> = (
    instance,
    settings,
  ) =>
    rateLimit(instance, {
      ...settings,
      redis: undefined,
      allowList: () => true,
    });

  // fastify-plugin's marks travel with it, skip-override above all: the
  // limiter and app.rateLimit() belong to the root instance, as in http.ts.
  for (const mark of Object.getOwnPropertySymbols(rateLimit)) {
    Object.assign(isolated, {
      [mark]: (rateLimit as unknown as Record<symbol, unknown>)[mark],
    });
  }

  return { default: isolated };
});

/**
 * The replica must never be the side that closes an idle keep-alive
 * connection to the proxy.
 *
 * Traefik keeps idle upstream connections for 90 s (its serversTransport
 * default). Fastify's own keep-alive default is 72 s, so the replica closed
 * first, and a request Traefik wrote on that connection in the same instant was
 * lost. Go retries a lost GET but not a POST: the load harness measured 16 POST
 * /route/positions answered 502 in one stress run, with the event loop busy
 * enough to run the overdue keep-alive timer before reading the request already
 * waiting on the socket (the load of 07/10/2026, docs/desempenho/README.md).
 */
const TRAEFIK_DEFAULT_IDLE_MS = 90_000;

function seconds(text: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(text.trim());

  if (!match) throw new Error(`Duração do Traefik não reconhecida: ${text}`);

  return (
    Number(match[1]) *
    { ms: 1, s: 1_000, m: 60_000 }[match[2] as "ms" | "s" | "m"]
  );
}

/** The idle timeout the versioned Traefik config gives its upstreams, or its default. */
function traefikUpstreamIdleMs(): number {
  const dir = resolve(process.cwd(), "infra", "traefik");
  const sources = [join(dir, "traefik.reference.yaml")];

  for (const name of readdirSync(join(dir, "dynamic")))
    sources.push(join(dir, "dynamic", name));

  const declared = sources
    .map((path) => readFileSync(path, "utf8"))
    .flatMap((text) =>
      [...text.matchAll(/idleConnTimeout:\s*"?([0-9]+(?:ms|s|m))"?/g)].map(
        (match) => seconds(match[1]),
      ),
    );

  return Math.max(TRAEFIK_DEFAULT_IDLE_MS, ...declared);
}

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

// One boot for the file, closed once at the end: a closed Fastify answers
// every request with 503 and Connection: close (return503OnClosing), which
// would read as the cap firing on every response.
afterAll(async () => {
  const { app } = await import("@/http");
  await app.close();
});

describe("keep-alive between Traefik and a replica", () => {
  it(
    "outlasts the proxy's idle timeout, so the proxy always closes first",
    async () => {
      const { app } = await import("@/http");
      await app.ready();

      expect(app.server.keepAliveTimeout).toBeGreaterThan(
        traefikUpstreamIdleMs(),
      );

      // Still bounded: an idle socket is a file descriptor and a little memory.
      expect(app.server.keepAliveTimeout).toBeLessThanOrEqual(120_000);
    },
    APP_BOOT_TIMEOUT_MS,
  );
});

/** One GET on the agent's connection: status, Connection header and socket. */
function get(
  port: number,
  agent: Agent,
): Promise<{
  status: number;
  connection: string | undefined;
  socket: Socket;
}> {
  return new Promise((resolveGet, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health/liveness", agent },
      (res) => {
        res.resume();
        res.once("end", () =>
          resolveGet({
            status: res.statusCode ?? 0,
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
 * A replica added by a scale-up must get its share of the traffic
 * (plano-escala F1-15).
 *
 * The Swarm spreads CONNECTIONS, not requests, and Traefik keeps each one
 * for up to 90 s of idleness: under steady traffic a connection never goes
 * idle, so the replicas that were already up keep their connections, and
 * the new one sat almost empty. Now a connection serves at most
 * HTTP_MAX_REQUESTS_PER_SOCKET requests (1 000 by default) and its last
 * response says `Connection: close`: Traefik opens the next one, which the
 * Swarm may send to any replica. A response that says close is never
 * reused, so this opens no race with a request in flight.
 */
describe("requests per keep-alive connection", () => {
  it("defaults to 1 000, and 0 turns the cap off", () => {
    const base = {
      NODE_ENV: "development",
      REDIS_URL: "redis://localhost:6379",
      HTTP_REQUEST: "http://localhost:3000",
      JWT_SECRET: "a".repeat(32),
      JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
      MASTER_USER_EMAIL: "master@example.com",
      MASTER_USER_INITIAL_PASSWORD: "x",
    };
    const cap = (value?: string) => {
      const parsed = envSchema.safeParse(
        value === undefined
          ? base
          : { ...base, HTTP_MAX_REQUESTS_PER_SOCKET: value },
      );

      return parsed.success
        ? (parsed.data as { HTTP_MAX_REQUESTS_PER_SOCKET: number })
            .HTTP_MAX_REQUESTS_PER_SOCKET
        : "refused";
    };

    expect(cap()).toBe(1_000);
    expect(cap("")).toBe(1_000);
    expect(cap("0")).toBe(0);
    expect(cap("250")).toBe(250);
    expect(cap("-1")).toBe("refused");
  });

  it(
    "says close on the 1 000th response of a connection, and the replica ends it",
    async () => {
      const { app } = await import("@/http");
      await app.listen({ host: "127.0.0.1", port: 0 });

      expect(app.server.maxRequestsPerSocket).toBe(1_000);

      const { port } = app.server.address() as AddressInfo;
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });

      cleanup.push(() => agent.destroy());

      const statuses = new Set<number>();
      const headers: Array<string | undefined> = [];
      const sockets = new Set<Socket>();
      let last: Socket | null = null;

      for (let index = 0; index < 1_000; index += 1) {
        const { status, connection, socket } = await get(port, agent);

        statuses.add(status);
        headers.push(connection);
        sockets.add(socket);
        last = socket;
      }

      // Every one answered by the route itself. A 429 here means these
      // requests are charged again to a limiter key that other test files
      // share (see the vi.mock at the top).
      expect([...statuses]).toEqual([200]);

      // One connection carried all of them, kept alive until the last.
      expect(sockets.size).toBe(1);
      expect(
        headers.slice(0, 999).every((value) => value === "keep-alive"),
      ).toBe(true);
      expect(headers[999]).toBe("close");

      // The replica closes it; the next request opens another one.
      if (last && !last.destroyed) {
        await new Promise<void>((closed) =>
          last?.once("close", () => closed()),
        );
      }

      const next = await get(port, agent);

      expect(sockets.has(next.socket)).toBe(false);
      expect(next.status).toBe(200);
      expect(next.connection).toBe("keep-alive");
    },
    APP_BOOT_TIMEOUT_MS,
  );
});

/**
 * The cap must hold whatever the response is (found by the rolling
 * rehearsal, plano-escala LOAD-06).
 *
 * The NDJSON listings set `Connection: keep-alive` themselves
 * (config/stream-utils.ts). Node skips its own keep-alive logic when a
 * response names its Connection, so when the capped response of a
 * connection was a listing it said keep-alive instead of close: Traefik
 * used the connection once more, and Node answered that request 503 (a
 * request past maxRequestsPerSocket), with no log line. The Swarm
 * rehearsal measured nine to sixteen such 503s per run at 50 req/s. The
 * listing now leaves the header to Node, which also keeps the drain's
 * close (closeConnectionWhileDraining) the only one the API sets.
 */
describe("a listing as the capped response", () => {
  it("says close, and the request after it opens another connection", async () => {
    const { default: fastify } = await import("fastify");
    const { sendAsNDJSON } = await import("@/config/stream-utils");

    const server = fastify({ maxRequestsPerSocket: 2 });

    server.get("/list", (_request, reply) =>
      sendAsNDJSON({
        reply,
        dataPromise: Promise.resolve({ data: [{ id: 1 }], total: 1 }),
        page: 1,
        pageSize: 20,
      }),
    );

    await server.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.close());

    const { port } = server.server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    cleanup.push(() => agent.destroy());

    const read = () =>
      new Promise<{ status: number; connection?: string; socket: Socket }>(
        (done, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port, path: "/list", agent },
            (res) => {
              res.resume();
              res.once("end", () =>
                done({
                  status: res.statusCode ?? 0,
                  connection: res.headers.connection,
                  socket: req.socket as Socket,
                }),
              );
            },
          );

          req.once("error", reject);
          req.end();
        },
      );

    const first = await read();
    const capped = await read();
    const after = await read();

    expect(first.connection).toBe("keep-alive");
    expect(capped.connection).toBe("close");
    expect(after.status).toBe(200);
    expect(after.socket).not.toBe(first.socket);
  });

  it("leaves the Connection header of a listing to Node", () => {
    const sources = readFileSync(
      resolve(process.cwd(), "src", "config", "stream-utils.ts"),
      "utf8",
    );

    expect(sources).not.toMatch(/header\(\s*["']connection["']/i);
  });
});
