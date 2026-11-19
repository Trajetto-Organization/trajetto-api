// @vitest-environment node
import pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import { databaseBusyAnswer } from "@/shared/errors/database-error-map";
import { isDatabaseUnavailable } from "@/shared/errors/database-unavailable";

import { infraUrl } from "./support/infra-urls";

/**
 * PgBouncer's "come back in a moment", through the real PgBouncer and the
 * API's own client (plano-escala F4-32; tests/E2E/infra/run.sh starts it).
 *
 * When every server connection of a pool stays busy past
 * query_wait_timeout (5 s in the image), PgBouncer drops the waiting client
 * with SQLSTATE 08P01, at FATAL, and the words `query_wait_timeout`. 08P01
 * is the code PgBouncer gives to everything it says, so the shape of that
 * error as the API meets it — through @prisma/adapter-pg and Prisma 7, on a
 * raw query, a model query and an interactive transaction — is what the
 * error map must recognise, and nothing else. The request behind it gets
 * 503 SERVICE_BUSY with Retry-After, not a 500
 * (tests/unitaires/http/database-error-map.test.ts takes the handler).
 *
 * The pool is filled for real: as many clients as the pool has server
 * connections hold a transaction open, so the next statement waits. They
 * are released at the end, and the pool answers again.
 */
const POOLED = infraUrl("pgbouncer");
const STATS = infraUrl("pgbouncerStats");

/** The runtime's pooled URL (F4-31): pgbouncer=true, one connection. */
function runtimeUrl(): string {
  const url = new URL(POOLED);

  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "20");
  url.searchParams.set("socket_timeout", "30");

  return url.toString();
}

/** PgBouncer's own setting, read through the stats login. */
async function bouncerSetting(name: string): Promise<string> {
  const stats = new pg.Client({ connectionString: STATS });

  await stats.connect();

  try {
    const { rows } = await stats.query<{ key: string; value: string }>(
      "SHOW CONFIG",
    );
    const value = rows.find((row) => row.key === name)?.value;

    if (value === undefined) throw new Error(`SHOW CONFIG sem ${name}`);

    return value;
  } finally {
    await stats.end();
  }
}

/** Past PgBouncer's wait (5 s) and the stack's logins, with room. */
const TEST_TIMEOUT_MS = 60_000;

const holders: pg.Client[] = [];
const clients: PrismaClient[] = [];

/** A Prisma client on its own pool, closed at the end. */
function prismaClient(): PrismaClient {
  const client = createPrismaClient({}, { url: runtimeUrl() });

  clients.push(client);

  return client;
}

/** Every server connection of the pool held by an open transaction. */
async function fillThePool(): Promise<void> {
  const size = Number(await bouncerSetting("default_pool_size"));

  expect(size).toBeGreaterThan(0);

  for (let index = 0; index < size; index += 1) {
    const holder = new pg.Client({ connectionString: POOLED });

    await holder.connect();
    holders.push(holder);
    // In transaction mode the server connection stays with the client
    // until the transaction ends.
    await holder.query("BEGIN");
    await holder.query("SELECT 1");
  }
}

async function releaseThePool(): Promise<void> {
  for (const holder of holders.splice(0)) {
    await holder.query("COMMIT").catch(() => {});
    await holder.end().catch(() => {});
  }
}

let queryWaitTimeoutSeconds = 0;

beforeAll(async () => {
  queryWaitTimeoutSeconds = Number(await bouncerSetting("query_wait_timeout"));
});

afterAll(async () => {
  await releaseThePool();
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("PgBouncer's query_wait_timeout, as the API meets it", () => {
  it(
    "is SERVICE_BUSY with Retry-After on a raw query, a model query and an interactive transaction",
    async () => {
      expect(queryWaitTimeoutSeconds).toBeGreaterThan(0);

      // Each on a client of its own: the FATAL ends the connection it came on.
      const raw = prismaClient();
      const model = prismaClient();
      const interactive = prismaClient();

      // Logged in before the pool is full: the wait below is for a server
      // connection, not for the login.
      await raw.$queryRaw`SELECT 1`;
      await model.business.count();
      await interactive.$queryRaw`SELECT 1`;

      await fillThePool();

      const started = Date.now();
      const failures = await Promise.all([
        raw.$queryRaw`SELECT 1`.then(
          () => null,
          (error: unknown) => error,
        ),
        model.business.count().then(
          () => null,
          (error: unknown) => error,
        ),
        interactive
          .$transaction(async (tx) => tx.$queryRaw`SELECT 1`, {
            maxWait: 20_000,
            timeout: 20_000,
          })
          .then(
            () => null,
            (error: unknown) => error,
          ),
      ]);
      const elapsedSeconds = (Date.now() - started) / 1000;

      // PgBouncer's wait, not the client's: well before pool_timeout's 20 s.
      expect(elapsedSeconds).toBeGreaterThanOrEqual(
        queryWaitTimeoutSeconds - 1,
      );
      expect(elapsedSeconds).toBeLessThan(queryWaitTimeoutSeconds + 10);

      for (const [index, failure] of failures.entries()) {
        const name = ["raw", "model", "interactive"][index];

        expect(failure, name).toBeInstanceOf(Error);
        expect(databaseBusyAnswer(failure), name).toMatchObject({
          statusCode: 503,
          code: "SERVICE_BUSY",
          retryAfterSeconds: 2,
          reason: "pgbouncer_query_wait_timeout",
          sqlState: "08P01",
          logLevel: "warn",
        });
        // Busy, not gone: never the outage's answer.
        expect(isDatabaseUnavailable(failure), name).toBe(false);
      }

      await releaseThePool();

      // The pool answers again, on the same clients (a new connection each).
      await expect(raw.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
      await expect(model.business.count()).resolves.toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT_MS,
  );
});
