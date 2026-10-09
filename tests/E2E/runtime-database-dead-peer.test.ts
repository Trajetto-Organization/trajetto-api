import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDatabaseUnavailable } from "@/shared/errors/database-unavailable";

import { SilentProxy, settle } from "./support/silent-proxy";

/**
 * The production runtime connection, as compose.production.yaml writes it,
 * against a peer that goes silent (GAP6-4).
 *
 * A dead peer is not a refused connection: when a node is lost, the network
 * partitions or the Swarm VIP (IPVS) forgets a flow idle for 900 s, the
 * packets simply stop arriving — no FIN, no RST. With no socket_timeout and
 * no idle lifetime, the request on that connection waited for the kernel to
 * give up (~15 min) and the rest of the pool queued into P2024 with the
 * database up.
 *
 * The compose values are minutes long, so each one PRESENT in the compose URL
 * is scaled down to a second here. A parameter the compose does not set stays
 * unset, and the case waits like production would.
 */
const compose = readFileSync(resolve(process.cwd(), "compose.production.yaml"), "utf8");

function apiVariable(name: string): string | undefined {
  const api = compose.slice(compose.indexOf("\n  api:"));

  return api.match(new RegExp(`^\\s+${name}: (.+?)\\s*$`, "m"))?.[1];
}

const SCALED_SECONDS: Record<string, string> = {
  socket_timeout: "1",
  max_idle_connection_lifetime: "1",
};

let proxy: SilentProxy;
let proxyPort = 0;
const clients: PrismaClient[] = [];

/** The compose runtime URL, pointed at the proxy, its timeouts scaled down. */
function runtimeClient(): PrismaClient {
  const template = apiVariable("DATABASE_URL");

  expect(template, "DATABASE_URL do serviço api").toBeTruthy();

  const own = new URL(process.env.DATABASE_URL as string);
  const values: Record<string, string> = {
    POSTGRES_USERNAME: own.username,
    POSTGRES_PASSWORD: own.password,
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: String(proxyPort),
    POSTGRES_DATABASE: own.pathname.slice(1),
  };

  const url = new URL(
    template!.replace(/\$\{(\w+)(?::?-[^}]*)?\}/g, (_, key: string) => values[key] ?? ""),
  );

  // One connection: the query under test runs on the flow the test killed.
  url.searchParams.set("connection_limit", "1");

  for (const [name, seconds] of Object.entries(SCALED_SECONDS)) {
    if (url.searchParams.has(name)) url.searchParams.set(name, seconds);
  }

  const client = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
  clients.push(client);

  return client;
}

beforeAll(async () => {
  proxy = SilentProxy.for(process.env.DATABASE_URL as string);
  proxyPort = await proxy.listen();
});

afterAll(async () => {
  // Sockets first: a client still waiting on a forgotten flow then sees the
  // connection close and lets $disconnect finish.
  await proxy.close();
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("the runtime connection when the network forgets an idle flow", () => {
  it("opens a fresh connection instead of writing into the dead one", { timeout: 15_000 }, async () => {
    const client = runtimeClient();

    await client.user.count();

    proxy.forgetOpenFlows();

    // Idle past the (scaled) max_idle_connection_lifetime, like a pooled
    // connection left unused overnight past the VIP's 900 s.
    await new Promise((done) => setTimeout(done, 2_200));

    const outcome = await settle(client.user.count(), 4_000);

    expect(outcome.kind).toBe("answered");
    expect(outcome.ms).toBeLessThan(1_000);
  });
});

describe("the runtime connection when the peer dies under a query", () => {
  it(
    "fails the request within socket_timeout, as 'database unavailable', instead of waiting for the kernel",
    { timeout: 15_000 },
    async () => {
      const client = runtimeClient();

      // Prepared on this connection: socket_timeout bounds the execution of
      // a statement. It does NOT bound preparing a new one (Prisma 6.1) —
      // docs/arquitetura.md (Conexão com o Postgres) says what covers that.
      await client.user.count();

      proxy.forgetOpenFlows();

      const outcome = await settle(client.user.count(), 4_000);

      expect(outcome.kind).toBe("failed");
      expect(outcome.ms).toBeLessThan(2_500);

      // P1008: the error handler answers 503 + Retry-After, not a 500.
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
    },
  );
});

/** What a failed query carried, for the assertion message. */
function describeError(error: unknown): string {
  const { code, meta, message } = (error ?? {}) as {
    code?: unknown;
    meta?: unknown;
    message?: unknown;
  };

  return JSON.stringify({ code, meta, message });
}

describe("a raw query when the peer dies under it (GAP6-4)", () => {
  /**
   * $queryRaw does not fail like the model's queries. The same socket_timeout
   * comes back as P2010 "Raw query failed" with the code `N/A` — no SQLSTATE,
   * because Postgres never answered — and the global handler answered 500:
   * /health/metrics, the dashboard, the dead letter and every other raw read
   * told the client "bug" during the very outage the 503 exists for.
   */
  it(
    "is 'database unavailable' too, so the API answers 503 and not 500",
    { timeout: 15_000 },
    async () => {
      const client = runtimeClient();

      // Prepared on this connection, as above.
      await client.$queryRaw`SELECT 1 AS "one"`;

      proxy.forgetOpenFlows();

      const outcome = await settle(client.$queryRaw`SELECT 1 AS "one"`, 4_000);

      expect(outcome.kind).toBe("failed");

      const error = (outcome as { error: unknown }).error;

      expect(isDatabaseUnavailable(error), describeError(error)).toBe(true);
    },
  );

  it("while a raw query Postgres itself refused stays a 500", { timeout: 15_000 }, async () => {
    const client = runtimeClient();

    const outcome = await settle(
      client.$queryRaw`SELECT * FROM "gap6_4_no_such_table"`,
      4_000,
    );

    expect(outcome.kind).toBe("failed");

    const error = (outcome as { error: unknown }).error;

    // P2010 as well, but carrying the SQLSTATE: an answer about the SQL.
    expect((error as { code?: string }).code, describeError(error)).toBe("P2010");
    expect(isDatabaseUnavailable(error), describeError(error)).toBe(false);
  });
});
