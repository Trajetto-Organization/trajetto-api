import { afterAll, describe, expect, it } from "vitest";

import database, {
  BATCH_POOL,
  databaseBatch,
  databaseBatchPool,
  databasePool,
  databaseRead,
  databaseReadPool,
} from "@/../infra/database";

/**
 * The two side pools of infra/database.ts against a real Postgres
 * (plano-escala F3-16): the heavy reads' bulkhead and the maintenance pool.
 *
 * Why each property matters:
 *  - lazy: every replica imports infra/database, and most never use a side
 *    pool; with neither URL set they share DATABASE_URL's server, so a
 *    connection opened for nothing is one fewer for the requests;
 *  - 3 connections at most: a purge or an export must not take what the
 *    requests need (the bulkhead), and the connection budget of the plan
 *    counts 3 per side pool (section 2.2);
 *  - each its own ceiling: 10 s for a read that a screen waits for, 30 min
 *    for a VACUUM or a DETACH that nobody waits for;
 *  - BATCH_DATABASE_URL, when set, is the batch pool's URL: after the cut
 *    of the database roles it is the trajetto_batch login.
 */
const BATCH_PROBE = "wfl-batch-pool-probe";

afterAll(async () => {
  delete process.env.BATCH_DATABASE_URL;
  await databaseRead.$disconnect();
  await databaseBatch.$disconnect();
});

describe("the side pools", () => {
  it("open nothing until they are used", async () => {
    // The app's own client is used: the side pools are not.
    await database.$queryRaw`SELECT 1`;

    expect(databasePool()).not.toBeNull();
    expect(databaseReadPool()).toBeNull();
    expect(databaseBatchPool()).toBeNull();
  });

  it("put the bulkhead's statements under 10 s, on a pool of its own", async () => {
    const [row] = await databaseRead.$queryRaw<Array<{ ceiling: string }>>`
      SELECT current_setting('statement_timeout') AS ceiling
    `;

    expect(row.ceiling).toBe("10s");
    expect(databaseReadPool()).not.toBeNull();
    expect(databaseReadPool()).not.toBe(databasePool());
  });

  it("run the batch pool on BATCH_DATABASE_URL, 30 min a statement, never more than 3 connections", async () => {
    const url = new URL(process.env.DATABASE_URL as string);

    url.searchParams.set("application_name", BATCH_PROBE);
    process.env.BATCH_DATABASE_URL = url.toString();

    // Six statements at once on a pool of three: three wait their turn.
    const rows = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          databaseBatch.$queryRaw<
            Array<{ pid: number; ceiling: string; app: string }>
          >`
            SELECT pg_backend_pid() AS pid,
                   current_setting('statement_timeout') AS ceiling,
                   current_setting('application_name') AS app,
                   (SELECT 1 FROM pg_sleep(0.3)) AS slept
          `,
      ),
    );

    const pids = new Set(rows.map(([row]) => row.pid));

    expect(pids.size).toBeLessThanOrEqual(BATCH_POOL.max);
    expect(rows.every(([row]) => row.ceiling === "30min")).toBe(true);
    expect(rows.every(([row]) => row.app === BATCH_PROBE)).toBe(true);
    expect(databaseBatchPool()?.totalCount).toBeLessThanOrEqual(BATCH_POOL.max);
  });

  it("serve model queries and transactions like the app's own client", async () => {
    const count = await databaseBatch.scheduledJobExecution.count();
    const inside = await databaseBatch.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;

      return row.ok;
    });

    expect(typeof count).toBe("number");
    expect(inside).toBe(1);
  });
});
