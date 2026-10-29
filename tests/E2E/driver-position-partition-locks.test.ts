import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The nightly partition DDL must not queue the pings behind itself.
 *
 * `CREATE TABLE ... PARTITION OF driver_position` and `DROP TABLE` of a
 * partition both take ACCESS EXCLUSIVE on the PARENT. While anything holds a
 * lock on driver_position — a pg_dump running at night, an ad-hoc query, an
 * autovacuum — that request waits, and every INSERT of a ping queues behind
 * the waiting request, each holding a pool connection. With no lock_timeout
 * the wait had no bound: the pool drained and every route of the replica
 * failed.
 *
 * The job now asks for the lock with a short lock_timeout, skips the partition
 * it could not get and tries again the next night — the seven days of
 * lookahead exist for exactly this.
 */
const holder = createPrismaClient({ log: [] });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function nameFor(offsetDays: number): string {
  const day = new Date();

  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + offsetDays);

  return `driver_position_${day.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

async function attached(): Promise<string[]> {
  const rows = await holder.$queryRawUnsafe<Array<{ relname: string }>>(`
    SELECT child.relname::text AS relname
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'driver_position'
  `);

  return rows.map((row) => row.relname);
}

/** Holds ACCESS SHARE on driver_position for `ms`, like a running pg_dump. */
function holdParentLock(ms: number): Promise<void> {
  let locked!: () => void;
  const ready = new Promise<void>((done) => (locked = done));

  const held = holder.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 FROM "driver_position" LIMIT 1`);
      locked();
      await sleep(ms);
    },
    { timeout: ms + 10_000, maxWait: 5_000 },
  );

  return ready.then(() => held.then(() => undefined));
}

let job: (typeof import("@/jobs/cron/driver-position-partitions-job"))["driverPositionPartitionsJob"];
let lookahead: number;

beforeAll(async () => {
  const module = await import("@/jobs/cron/driver-position-partitions-job");

  job = module.driverPositionPartitionsJob;
  lookahead = module.PARTITION_LOOKAHEAD_DAYS;

  await job.handler();
}, 60_000);

afterAll(async () => {
  await holder.$disconnect();
});

describe("partition maintenance while something reads the trail", () => {
  it("gives up on the partition it cannot lock, quickly, and gets it the next run", async () => {
    const farthest = nameFor(lookahead);

    await holder.$executeRawUnsafe(`DROP TABLE IF EXISTS "${farthest}"`);
    expect(await attached()).not.toContain(farthest);

    const lockHeld = holdParentLock(12_000);

    // Give the holder time to take its lock.
    await sleep(500);

    const startedAt = Date.now();
    const outcome = await job.handler().then(
      () => "resolved",
      (error: unknown) => `rejected: ${String(error)}`,
    );
    const elapsed = Date.now() - startedAt;

    // Before: the CREATE waited for the whole 12 s, and in production for
    // as long as the holder lived, with every ping queued behind it.
    expect(elapsed, `levou ${elapsed} ms (${outcome})`).toBeLessThan(8_000);

    // A partition a week ahead is not worth failing the run over.
    expect(outcome).toBe("resolved");
    expect(await attached()).not.toContain(farthest);

    await lockHeld;

    await job.handler();
    expect(await attached()).toContain(farthest);
  }, 40_000);

  it("fails the run when it cannot secure the partitions pings land in now", async () => {
    const tomorrow = nameFor(1);

    // Only an empty partition may go: tomorrow's has no rows yet.
    await holder.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tomorrow}"`);

    const lockHeld = holdParentLock(8_000);

    await sleep(500);

    // Missing tomorrow is not a warning for next week: the first ping after
    // midnight is REFUSED. The run is recorded as failed so it is seen.
    await expect(job.handler()).rejects.toThrow(/driver_position_\d{8}/);

    await lockHeld;

    await job.handler();
    expect(await attached()).toContain(tomorrow);
  }, 40_000);
});
