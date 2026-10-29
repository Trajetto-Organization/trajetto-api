import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { createPrismaClient } from "@/shared/database/database-client";
import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";
import {
  driverAdapterCauseOf,
  isSerializationFailure,
  sqlStateOf,
} from "@/shared/errors/prisma-error-meta";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { CommitResetProxy } from "./support/commit-reset-proxy";

/**
 * The database going away at the COMMIT of an interactive `$transaction`,
 * through the real driver, the real app and its error handler.
 *
 * Prisma 7.10.1 runs that COMMIT outside the path that wraps the adapter's
 * errors in Prisma's classes, so the caller gets adapter-pg's bare
 * DriverAdapterError. isDatabaseUnavailable trusted only Prisma's classes and
 * the pool's error, and the handler answered `500 INTERNAL_ERROR` with no
 * Retry-After, logged as a bug, where Prisma 6 raised P1017 and the API
 * answered 503. Two real ways in:
 *
 * - the backend running the COMMIT is terminated, as a restart or a failover
 *   does: kind `postgres`, SQLSTATE 57P01, and the transaction never commits;
 * - the connection is reset after Postgres ran the COMMIT: kind
 *   `ConnectionClosed`, and the row IS there. A 503 never meant "not
 *   executed"; that is why a retried write needs an Idempotency-Key, and why
 *   neither shape is a serialization failure the retry loops would run again.
 *
 * The COMMIT is held open by a deferred constraint trigger that sleeps, so
 * the backend can be found in pg_stat_activity and terminated mid-COMMIT.
 */

/** How long the deferred trigger holds the COMMIT if nothing terminates it. */
const SLOW_COMMIT_SECONDS = 10;

/** How long the test looks for the backend sitting in that COMMIT. */
const FIND_COMMIT_TIMEOUT_MS = 5_000;

type App = Awaited<typeof import("@/http")>["app"];

let app: App;
let observer: PrismaClient;
let proxy: CommitResetProxy;

const clients: PrismaClient[] = [];

/** What the route's transaction threw, before the error handler answered. */
let thrown: unknown;

/** The messages the error handler logged at warn or error for the request. */
const logged: string[] = [];

/** The app's client, at this test's database or at the proxy in front of it. */
function clientAt(port?: number): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);

  if (port !== undefined) {
    url.hostname = "127.0.0.1";
    url.port = String(port);
  }

  const client = createPrismaClient({ log: [] }, { url: url.toString() });
  clients.push(client);

  return client;
}

beforeAll(async () => {
  observer = clientAt();

  await observer.$executeRawUnsafe(
    `CREATE TABLE "commit_probe" ("id" text PRIMARY KEY)`,
  );
  await observer.$executeRawUnsafe(
    `CREATE TABLE "commit_probe_slow" ("id" text PRIMARY KEY)`,
  );
  await observer.$executeRawUnsafe(
    `CREATE FUNCTION "commit_probe_slow_fn"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_sleep(${SLOW_COMMIT_SECONDS}); RETURN NULL; END
       $$`,
  );
  // Deferred: it runs inside the COMMIT, after the route's work is done.
  await observer.$executeRawUnsafe(
    `CREATE CONSTRAINT TRIGGER "commit_probe_slow_trg"
       AFTER INSERT ON "commit_probe_slow"
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION "commit_probe_slow_fn"()`,
  );

  proxy = CommitResetProxy.for(process.env.DATABASE_URL as string);

  const direct = clientAt();
  const throughProxy = clientAt(await proxy.listen());

  const routes = {
    terminated: { client: direct, table: "commit_probe_slow" },
    reset: { client: throughProxy, table: "commit_probe" },
  } as const;

  ({ app } = await import("@/http"));

  // Registered before `ready()`, so it goes through the real hooks and the
  // real error handler.
  app.get<{ Params: { route: keyof typeof routes; id: string } }>(
    "/__test/commit/:route/:id",
    {
      config: { rateLimit: false },
      // The handler logs through request.log; record its messages, keeping
      // the real logger underneath for everything else.
      onRequest: async (request) => {
        const real = request.log;

        request.log = Object.assign(Object.create(real), {
          error: (_context: unknown, message: string) => {
            logged.push(message);
          },
          warn: (_context: unknown, message: string) => {
            logged.push(message);
          },
        });
      },
    },
    async (request) => {
      const { client, table } = routes[request.params.route];

      thrown = undefined;

      try {
        await client.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO "${table}" ("id") VALUES ($1)`,
              request.params.id,
            );
          },
          // Prisma's own timer stays out of the way of the slow COMMIT.
          { timeout: (SLOW_COMMIT_SECONDS + 5) * 1_000 },
        );

        return { ok: true };
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
  );

  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await proxy?.close();
  await app?.close();
  await Promise.all(clients.map((client) => client.$disconnect()));
});

const call = async (route: string, id: string) => {
  logged.length = 0;

  return app.inject({ method: "GET", url: `/__test/commit/${route}/${id}` });
};

/** The backend of this database sitting in the deferred trigger's COMMIT. */
async function backendInSlowCommit(): Promise<number> {
  const deadline = Date.now() + FIND_COMMIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{ pid: number }>>`
      SELECT "pid" FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "pid" <> pg_backend_pid()
        AND "state" = 'active'
        AND "query" = 'COMMIT'
        AND "wait_event" = 'PgSleep'`;

    if (rows.length > 0) return rows[0].pid;

    await new Promise((done) => setTimeout(done, 25));
  }

  throw new Error("no backend reached the slow COMMIT");
}

async function rowsWithId(table: string, id: string): Promise<number> {
  const [{ count }] = await observer.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS "count" FROM "${table}" WHERE "id" = $1`,
    id,
  );

  return count;
}

/** The answer the API gives when the database, not the request, failed. */
function expectServiceUnavailable(
  response: Awaited<ReturnType<typeof call>>,
): void {
  expect(response.statusCode, response.body).toBe(503);
  expect(response.headers["retry-after"]).toBe(
    String(DATABASE_RETRY_AFTER_SECONDS),
  );
  expect(response.headers["x-error-code"]).toBe("SERVICE_UNAVAILABLE");
  expect(response.json().code).toBe("SERVICE_UNAVAILABLE");

  // Logged as an outage, not as the bug the alert pages for.
  expect(logged).toEqual(["Database unavailable while processing request"]);
}

/** The shape this file exists for: the adapter's own error, no Prisma class. */
function expectBareAdapterError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("DriverAdapterError");
  expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
}

describe("the database going away at COMMIT, through the real driver and handler", () => {
  it(
    "answers 503 with Retry-After when the backend running the COMMIT is terminated",
    { timeout: 30_000 },
    async () => {
      const id = randomUUID();
      const pending = call("terminated", id);

      const pid = await backendInSlowCommit();

      await observer.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;

      const response = await pending;

      expectBareAdapterError(thrown);
      expect(driverAdapterCauseOf(thrown)?.kind).toBe("postgres");
      expect(sqlStateOf(thrown)).toBe("57P01");

      expectServiceUnavailable(response);

      // Neither the SQLSTATE nor Postgres' words reach the body.
      expect(response.body).not.toContain("57P01");
      expect(response.body).not.toMatch(/terminat/i);

      // An outage, not a conflict: the serializable loops do not run it again.
      expect(isSerializationFailure(thrown)).toBe(false);

      // Terminated inside the COMMIT: nothing was committed.
      expect(await rowsWithId("commit_probe_slow", id)).toBe(0);
    },
  );

  it(
    "answers 503 with Retry-After when the connection is reset after the COMMIT ran",
    { timeout: 30_000 },
    async () => {
      const id = randomUUID();

      const response = await call("reset", id);

      expect(proxy.resets).toBe(1);

      expectBareAdapterError(thrown);
      expect(driverAdapterCauseOf(thrown)?.kind).toBe("ConnectionClosed");

      expectServiceUnavailable(response);
      expect(response.body).not.toContain("ConnectionClosed");

      expect(isSerializationFailure(thrown)).toBe(false);

      // Postgres had committed before the reset: the row is there, once. A
      // 503 does not mean "not executed", and running it again would write
      // it twice.
      expect(await rowsWithId("commit_probe", id)).toBe(1);
    },
  );
});
