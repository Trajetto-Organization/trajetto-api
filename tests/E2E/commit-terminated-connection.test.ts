import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { createPrismaClient } from "@/shared/database/database-client";
import { isDatabaseUnavailable } from "@/shared/errors/database-unavailable";
import {
  driverAdapterCauseOf,
  sqlStateOf,
} from "@/shared/errors/prisma-error-meta";

/**
 * A connection whose COMMIT Postgres answered with a FATAL is not handed out
 * again.
 *
 * A backend terminated in the middle of a COMMIT (a restart, a failover,
 * pg_terminate_backend) answers FATAL 57P01 and closes the socket. pg rejects
 * the COMMIT on that answer but keeps the connection queryable until it reads
 * the socket's end, and Prisma 7 releases a transaction's connection without
 * an error after a failed COMMIT. So the pool took the dead connection back
 * as healthy, and the very next query on it failed as `connection-lost`: a
 * 503 for a request that came after the outage (8 of 8 next queries at 0 ms,
 * pools of 1 and 10). The API's pool closes a connection whose statement got
 * a FATAL (src/shared/database/pg-driver.ts), and the next query opens a
 * fresh one.
 *
 * The COMMIT is held open by a deferred constraint trigger that sleeps, so
 * the backend can be found in pg_stat_activity and terminated mid-COMMIT.
 */

/** How long the deferred trigger holds the COMMIT if nothing terminates it. */
const SLOW_COMMIT_SECONDS = 10;

/** How long the test looks for the backend sitting in that COMMIT. */
const FIND_COMMIT_TIMEOUT_MS = 5_000;

/** Failed COMMITs per pool: without the fix, every one of them leaked. */
const ROUNDS = 3;

let observer: PrismaClient;

const clients: PrismaClient[] = [];

/** The app's client at this test's database, with `connectionLimit`. */
function clientWith(connectionLimit: number): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set("connection_limit", String(connectionLimit));

  const client = createPrismaClient({ log: [] }, { url: url.toString() });
  clients.push(client);

  return client;
}

beforeAll(async () => {
  observer = clientWith(2);

  await observer.$executeRawUnsafe(
    `CREATE TABLE "fatal_probe_slow" ("id" text PRIMARY KEY)`,
  );
  await observer.$executeRawUnsafe(
    `CREATE FUNCTION "fatal_probe_slow_fn"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_sleep(${SLOW_COMMIT_SECONDS}); RETURN NULL; END
       $$`,
  );
  // Deferred: it runs inside the COMMIT, after the transaction's work.
  await observer.$executeRawUnsafe(
    `CREATE CONSTRAINT TRIGGER "fatal_probe_slow_trg"
       AFTER INSERT ON "fatal_probe_slow"
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION "fatal_probe_slow_fn"()`,
  );
  // The control: a unique key checked at COMMIT, refused with an ERROR.
  await observer.$executeRawUnsafe(
    `CREATE TABLE "fatal_probe_unique" (
       "id" text,
       CONSTRAINT "fatal_probe_unique_id_key" UNIQUE ("id")
         DEFERRABLE INITIALLY DEFERRED
     )`,
  );
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

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

/** The backend serving `client`'s next query. */
async function backendOf(client: PrismaClient): Promise<number> {
  const [{ pid }] = await client.$queryRaw<Array<{ pid: number }>>`
    SELECT pg_backend_pid() AS "pid"`;

  return pid;
}

describe("a connection whose COMMIT Postgres answered with a FATAL", () => {
  it.each([1, 10])(
    "is not handed to the next query on a pool of %i, which runs on a fresh connection",
    { timeout: 30_000 },
    async (connectionLimit) => {
      const client = clientWith(connectionLimit);
      let previous = await backendOf(client);

      for (let round = 0; round < ROUNDS; round += 1) {
        const failure = client
          .$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(
                `INSERT INTO "fatal_probe_slow" ("id") VALUES ($1)`,
                randomUUID(),
              );
            },
            // Prisma's own timer stays out of the way of the slow COMMIT.
            { timeout: (SLOW_COMMIT_SECONDS + 5) * 1_000 },
          )
          .then(
            () => new Error("expected the COMMIT to fail"),
            (error: unknown) => error,
          );

        const terminated = await backendInSlowCommit();

        // The idle connection was reused for the transaction.
        expect(terminated).toBe(previous);

        await observer.$queryRaw`SELECT pg_terminate_backend(${terminated}::int)`;

        const error = await failure;

        // The FATAL at COMMIT, as the caller gets it.
        expect(driverAdapterCauseOf(error)?.kind).toBe("postgres");
        expect(sqlStateOf(error)).toBe("57P01");

        // At once, before pg could read the socket's end: the dead
        // connection used to be handed out here, and this failed with
        // connection-lost.
        const next = await backendOf(client).catch((nextError: unknown) => {
          throw new Error(
            `the next query failed (503: ${isDatabaseUnavailable(nextError)}): ${String(nextError)}`,
          );
        });

        expect(next).not.toBe(terminated);

        previous = next;
      }
    },
  );

  it(
    "while one refused with an ERROR (a unique key checked at COMMIT) keeps its connection",
    { timeout: 30_000 },
    async () => {
      const client = clientWith(1);
      const before = await backendOf(client);
      const id = randomUUID();

      const error = await client
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "fatal_probe_unique" ("id") VALUES ($1), ($1)`,
            id,
          );
        })
        .then(
          () => new Error("expected the COMMIT to fail"),
          (failure: unknown) => failure,
        );

      expect(sqlStateOf(error)).toBe("23505");

      // An answer about the data: the session goes on, and the pool's only
      // connection serves the next query.
      expect(await backendOf(client)).toBe(before);
    },
  );
});
