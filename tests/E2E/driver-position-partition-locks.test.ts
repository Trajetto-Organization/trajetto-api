import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import { partitionMaintenanceJob } from "@/jobs/cron/partition-maintenance-job";
import {
  addGrains,
  grainStart,
  partitionName,
  registeredPartitions,
} from "@/shared/database/partitions";

/**
 * The nightly partition DDL must not queue the pings behind itself.
 *
 * The job used to make a partition with CREATE TABLE … PARTITION OF, which
 * takes ACCESS EXCLUSIVE on driver_position itself. While anything held a
 * lock on it — a pg_dump at night, an ad-hoc query, an autovacuum — the
 * request waited, and every INSERT of a ping queued behind the waiting
 * request, each holding a pool connection. With no bound the pool drained
 * and every route of the replica failed; with a 3 s bound the pings still
 * stalled 3 s.
 *
 * Since partition-maintenance (plano-escala F2-08), a partition is LIKE +
 * ATTACH, which asks SHARE UPDATE EXCLUSIVE on the parent: a reader
 * (ACCESS SHARE) never holds it back, and an INSERT (ROW EXCLUSIVE) never
 * waits behind it, even while it waits. Only a VACUUM, an ANALYZE, a
 * CREATE INDEX or another DDL conflicts with it: the job tries a few times,
 * leaves that parent for the next night (the week of lookahead exists for
 * exactly this), and fails the run only when a partition pings land in
 * NOW is missing.
 */
const URL = () => process.env.DATABASE_URL as string;
const [trail] = registeredPartitions();

let admin: pg.Client;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function nameFor(offsetDays: number): string {
  return partitionName(
    trail,
    addGrains("day", grainStart("day", new Date()), offsetDays),
  );
}

async function attached(): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `SELECT c.relname::text AS relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'driver_position'::regclass`,
  );

  return rows.map((row) => row.relname);
}

/**
 * Holds `mode` on driver_position for `ms` from its own session; resolves
 * once the lock is held, with the release to await.
 */
async function holdParent(
  mode: string,
  ms: number,
): Promise<{ released: Promise<void> }> {
  const holder = await openReleaseClient(URL(), "e2e-partition-lock-holder");

  await holder.query("BEGIN");
  await holder.query(`LOCK TABLE driver_position IN ${mode} MODE`);

  const released = sleep(ms)
    .then(() => holder.query("COMMIT"))
    .then(() => holder.end());

  return { released };
}

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-partition-locks");

  await partitionMaintenanceJob.handler();
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe("partition maintenance while something holds the trail", () => {
  it("does not wait for a reader, as a pg_dump holds the table at night", async () => {
    const farthest = nameFor(trail.lookahead);

    await admin.query(`DROP TABLE IF EXISTS "${farthest}"`);

    const { released } = await holdParent("ACCESS SHARE", 10_000);

    try {
      const startedAt = Date.now();

      await partitionMaintenanceJob.handler();

      const elapsed = Date.now() - startedAt;

      // Before: the CREATE waited out its 3 s and was left for the next
      // night, with the pings stalled behind it.
      expect(elapsed, `levou ${elapsed} ms`).toBeLessThan(2_500);
      expect(await attached()).toContain(farthest);
    } finally {
      await released;
    }
  }, 30_000);

  it("never makes a ping wait while it waits for the lock, and gets the partition the next run", async () => {
    const farthest = nameFor(trail.lookahead);

    await admin.query(`DROP TABLE IF EXISTS "${farthest}"`);

    // What conflicts with ATTACH: a manual VACUUM or ANALYZE of the parent.
    const { released } = await holdParent("SHARE UPDATE EXCLUSIVE", 25_000);

    try {
      const run = partitionMaintenanceJob.handler().then(
        () => "resolved",
        (error: unknown) => `rejected: ${String(error)}`,
      );

      // The pings of the next seconds, while the ATTACH waits.
      const waits: number[] = [];
      const writer = await openReleaseClient(URL(), "e2e-partition-writer");

      try {
        for (let i = 0; i < 20; i += 1) {
          const startedAt = Date.now();

          await writer.query(
            `INSERT INTO driver_position (id, "driverId", "businessId", latitude, longitude, recorded_at)
             VALUES ($1, $2, $3, -23.5, -46.6, now())`,
            [randomUUID(), randomUUID(), randomUUID()],
          );
          waits.push(Date.now() - startedAt);
          await sleep(250);
        }
      } finally {
        await writer.end();
      }

      waits.sort((a, b) => a - b);

      // p99 of twenty is the slowest: none waited for the job.
      expect(waits[waits.length - 1], waits.join(",")).toBeLessThan(100);

      const startedAt = Date.now();
      const outcome = await run;

      // A partition a week ahead is not worth failing the run over: five
      // tries, then the next night.
      expect(outcome).toBe("resolved");
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(await attached()).not.toContain(farthest);
    } finally {
      await released;
    }

    await partitionMaintenanceJob.handler();
    expect(await attached()).toContain(farthest);
  }, 60_000);

  it("fails the run when it cannot secure the partitions pings land in now", async () => {
    const tomorrow = nameFor(1);

    // Only an empty partition may go: tomorrow's has no rows yet.
    await admin.query(`DROP TABLE IF EXISTS "${tomorrow}"`);

    const { released } = await holdParent("SHARE UPDATE EXCLUSIVE", 20_000);

    try {
      // Missing tomorrow is not a warning for next week: the first ping
      // after midnight is REFUSED. The run is recorded as failed so it is
      // seen.
      await expect(partitionMaintenanceJob.handler()).rejects.toThrow(
        /driver_position_\d{8}/,
      );
    } finally {
      await released;
    }

    await partitionMaintenanceJob.handler();
    expect(await attached()).toContain(tomorrow);
  }, 60_000);
});
