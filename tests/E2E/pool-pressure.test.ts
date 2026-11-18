import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A write must not be the first thing to give up when the pool is busy.
 *
 * Prisma queues a plain query for up to `pool_timeout` (20 s in production)
 * when every connection is taken, but it gives an interactive `$transaction`
 * only `maxWait` — two seconds by default — before failing it with P2028. So
 * under read pressure the order of casualties was exactly backwards: the
 * dashboard's counts waited their turn while the driver's proof of delivery,
 * a write inside a transaction, was the request that answered 500.
 *
 * The pool here is two connections and both are held by a three-second read.
 * The transaction has to wait for one of them and then succeed.
 */
const POOL = 2;
const HOLD_SECONDS = 3;

let database: PrismaClient;
let observer: PrismaClient;
let databasePool: () => { waitingCount: number } | null;
let databaseRead: PrismaClient;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.set("connection_limit", String(POOL));
  url.searchParams.set("pool_timeout", "20");

  // Same shape as production's URL, only a smaller pool, so the application's
  // own client is the one under test and not a copy of its options.
  observer = createPrismaClient(
    {},
    { url: process.env.DATABASE_URL as string },
  );

  process.env.DATABASE_URL = url.toString();

  ({
    default: database,
    databasePool,
    databaseRead,
  } = await import("@/../infra/database"));
});

afterAll(async () => {
  await database.$disconnect();
  await databaseRead.$disconnect();
  await observer.$disconnect();
});

/** Occupies every connection of `client` for HOLD_SECONDS. */
async function holdTheWholePool(
  client: PrismaClient,
): Promise<Promise<unknown>[]> {
  // Opened first, so the sleeps below are the ones holding the connections
  // and not a connect still in progress.
  await Promise.all(
    Array.from({ length: POOL }, () => client.$queryRaw`SELECT 1 AS warm`),
  );

  // `.then` because a PrismaPromise is lazy: without it nothing is sent until
  // somebody awaits it, and the pool would be idle.
  const held = Array.from({ length: POOL }, () =>
    client
      .$queryRawUnsafe(`SELECT 1 AS held FROM pg_sleep(${HOLD_SECONDS})`)
      .then((rows) => rows),
  );

  // Waits until Postgres itself reports both sleeps running.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ running }] = await observer.$queryRaw<{ running: number }[]>`
      SELECT count(*)::int AS running
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND query LIKE '%pg_sleep(%'
        AND pid <> pg_backend_pid()
    `;

    if (running >= POOL) return held;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("o pool nunca ficou ocupado; o teste não provaria nada");
}

describe("a transaction on a busy pool", () => {
  it("waits for a connection instead of failing at two seconds", async () => {
    const held = await holdTheWholePool(database);

    const result = await database.$transaction(
      async (tx) => tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`,
    );

    expect(result[0].ok).toBe(1);

    await Promise.all(held);
  }, 30_000);

  it("fails with Prisma's own defaults, which is why they are not used", async () => {
    /**
     * The mechanism, pinned down: a client with no transaction options gives
     * up at maxWait = 2 s with P2028. If Prisma ever changes that default this
     * test says so, and the one above stops proving anything.
     */
    const url = new URL(process.env.DATABASE_URL as string);
    const bare = createPrismaClient({}, { url: url.toString() });

    try {
      const held = await holdTheWholePool(bare);

      await expect(
        bare.$transaction(async (tx) => tx.$queryRaw`SELECT 1 AS ok`),
      ).rejects.toMatchObject({ code: "P2028" });

      await Promise.all(held);
    } finally {
      await bare.$disconnect();
    }
  }, 30_000);
});

describe("three slow exports", () => {
  /**
   * The heavy reads' bulkhead (plano-escala F3-17): an export reads through
   * databaseRead, a pool of its own, so three of them stuck on a slow table
   * hold its three connections and none of the main pool's — the one every
   * other request, the driver's proof included, needs. Before, three
   * exports took three connections of the pool of ten, and a burst of them
   * left the requests waiting their turn.
   *
   * The exports are slowed down for real: an observer's transaction holds
   * the vehicle table, so each export's first batch waits on the lock with
   * its connection in hand, as an export stuck on a slow plan would.
   */
  it("wait on the bulkhead, not on the main pool", async () => {
    const { VehicleRepository } =
      await import("@/modules/vehicle/repositories/vehicle-repository");
    const repository = new VehicleRepository();

    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const holder = observer.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "vehicle" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await released;
      },
      { maxWait: 5_000, timeout: 30_000 },
    );

    await isLocked;

    const drain = async () => {
      let rows = 0;

      for await (const _row of repository.streamVehiclesForExport({
        businessId: randomUUID(),
      })) {
        rows += 1;
      }

      return rows;
    };

    const exports = [drain(), drain(), drain()];

    try {
      // Postgres itself reports the three exports waiting on the lock. The
      // main pool has two connections: three waiting is already proof that
      // they are not on it.
      let waiting = 0;

      for (let attempt = 0; attempt < 100 && waiting < 3; attempt += 1) {
        const [row] = await observer.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%"vehicle"%'
        `;

        waiting = row.waiting;

        if (waiting < 3) await new Promise((r) => setTimeout(r, 50));
      }

      expect(waiting).toBe(3);

      // The main pool answers at once, a transaction included, with
      // nobody waiting for one of its connections.
      const started = Date.now();

      await database.$queryRaw`SELECT 1 AS ok`;
      await database.$transaction(async (tx) => tx.$queryRaw`SELECT 1 AS ok`);

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(databasePool()?.waitingCount ?? 0).toBe(0);
    } finally {
      release();
      await holder;
    }

    // And the exports finish once the table is free: nobody to export.
    await expect(Promise.all(exports)).resolves.toEqual([0, 0, 0]);
  }, 30_000);
});
