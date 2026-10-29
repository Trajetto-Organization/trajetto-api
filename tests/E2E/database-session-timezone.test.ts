import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import database, { databasePool } from "@/../infra/database";
import { createPrismaClient } from "@/shared/database/database-client";
import { probeUrl } from "@/shared/health/readiness-probe";

/**
 * Every session the API opens runs in UTC, whatever the database's default
 * (src/shared/database/pool-config.ts).
 *
 * The schema's DateTime columns are `timestamp(3)` WITHOUT time zone holding
 * UTC, and the queues and metrics meet them with now() in raw SQL
 * (`"availableAt" <= now()`, `"leaseExpiresAt" < now()`). Postgres converts
 * between the two in the session's TimeZone, so those queries were right only
 * because the Postgres images default to UTC — under Prisma 6 as well. Here
 * this file's throwaway database defaults to America/Sao_Paulo, as a server,
 * a database or a role may be configured, and the API's pools must still
 * open every session in UTC.
 */

const SAO_PAULO = "America/Sao_Paulo";

/** This file's own database: the prisma environment creates and drops it. */
function ownUrl(): URL {
  return new URL(process.env.DATABASE_URL as string);
}

/**
 * A plain pg session, as a client that asks for no zone opens one: it starts
 * in the database's default.
 */
async function onPlainSession<T>(
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = ownUrl();

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();

  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * The outbox lag query's filter (src/shared/health/operational-snapshot.ts):
 * the rows already due, a UTC column compared with now().
 */
const DUE_OUTBOX_SQL = `
  SELECT count(*)::int AS due
  FROM "domain_outbox_event"
  WHERE "status" = 'PENDING' AND "availableAt" <= now()
`;

type Queryable = Pick<PrismaClient, "$queryRawUnsafe">;

async function timeZoneOf(client: Queryable): Promise<string> {
  const [row] = await client.$queryRawUnsafe<Array<{ TimeZone: string }>>(
    "SHOW TimeZone",
  );

  return row.TimeZone;
}

async function dueOutboxOf(client: Queryable): Promise<number> {
  const [row] = await client.$queryRawUnsafe<Array<{ due: number }>>(
    DUE_OUTBOX_SQL,
  );

  return row.due;
}

const clients: PrismaClient[] = [];

beforeAll(async () => {
  const name = ownUrl().pathname.slice(1);

  // Affects the sessions opened from now on; none of this file's pools has
  // connected yet (they connect on their first query).
  await onPlainSession((client) =>
    client.query(`ALTER DATABASE "${name}" SET timezone = '${SAO_PAULO}'`),
  );

  // Written by the app's Prisma model, as a publish does: a UTC instant one
  // second ago, due already.
  await database.domainOutboxEvent.create({
    data: {
      eventKey: `session-timezone:${randomUUID()}`,
      topic: "test.session_timezone",
      aggregateType: "test",
      aggregateId: randomUUID(),
      payload: {},
      availableAt: new Date(Date.now() - 1_000),
    },
  });
});

afterAll(async () => {
  await Promise.all(
    [database, ...clients].map((client) => client.$disconnect()),
  );
});

describe("a session that asks for no zone", () => {
  /**
   * The control: without it, a UTC answer below could only mean the ALTER
   * did not take.
   */
  it("starts in the database's default, America/Sao_Paulo", async () => {
    const zone = await onPlainSession(async (client) => {
      const result = await client.query<{ TimeZone: string }>(
        "SHOW TimeZone",
      );

      return result.rows[0].TimeZone;
    });

    expect(zone).toBe(SAO_PAULO);
  });

  it("does not see the row that is due: the queue would claim it three hours late", async () => {
    const due = await onPlainSession(async (client) => {
      const result = await client.query<{ due: number }>(DUE_OUTBOX_SQL);

      return result.rows[0].due;
    });

    expect(due).toBe(0);
  });
});

describe("the app's pool (infra/database)", () => {
  it("opens every pooled connection in UTC", async () => {
    // Three transactions held open at once take three connections.
    const zones = await Promise.all(
      Array.from({ length: 3 }, () =>
        database.$transaction(async (tx) => {
          const zone = await timeZoneOf(tx);

          await tx.$executeRawUnsafe("SELECT pg_sleep(0.2)");

          return zone;
        }),
      ),
    );

    expect(zones).toEqual(["UTC", "UTC", "UTC"]);
    expect(databasePool()?.totalCount).toBeGreaterThanOrEqual(3);

    // And a connection handed out again by the pool.
    expect(await timeZoneOf(database)).toBe("UTC");
  });

  it("sees the row that is due, as on a UTC server", async () => {
    expect(await dueOutboxOf(database)).toBe(1);
  });
});

describe("the readiness probe's pool", () => {
  it("opens its connection in UTC", async () => {
    const probe = createPrismaClient(
      { log: [] },
      { url: probeUrl(ownUrl().toString()) },
    );

    clients.push(probe);

    expect(await timeZoneOf(probe)).toBe("UTC");
  });
});

describe("a URL that asks for a zone itself", () => {
  /**
   * Kept, not overruled: appending UTC after it would silently undo a choice
   * made on purpose.
   */
  it("gets that zone", async () => {
    const url = ownUrl();

    url.searchParams.set("options", `-c TimeZone=${SAO_PAULO}`);

    const zoned = createPrismaClient({ log: [] }, { url: url.toString() });

    clients.push(zoned);

    expect(await timeZoneOf(zoned)).toBe(SAO_PAULO);
  });
});
