import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The cluster's row of the per-minute series (plano-escala F1-10), against
 * Postgres and Redis.
 *
 * Every replica's node-cron fires the ops heartbeat each minute; the unique
 * (jobName, scheduledFor) insert elects one, and that one writes the
 * `role = 'cluster'` row after its ping, stamped with the elected minute.
 * Two replicas firing the same minute must leave ONE row: two would double
 * every cluster number a reader sums, and none would be a hole in the PITR
 * drill's marker.
 *
 * Two scheduler instances stand in for two replicas, as in
 * cron-scheduler-lock.test.ts: the election lives in the database.
 */
const prisma = createPrismaClient();

type Scheduler = {
  runExclusively(definition: CronJobDefinition, slot?: Date): Promise<void>;
};

let replicaA: Scheduler;
let replicaB: Scheduler;
let heartbeat: CronJobDefinition;

beforeAll(async () => {
  const { CronSchedulerService } =
    await import("@/shared/services/cron-scheduler-service");
  ({ opsHeartbeatJob: heartbeat } =
    await import("@/jobs/cron/ops-heartbeat-job"));

  // The constructor is private (one per process in production).
  const Constructor = CronSchedulerService as unknown as new () => Scheduler;

  replicaA = new Constructor();
  replicaB = new Constructor();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** A minute of its own, far from now, at `minute` past some hour (UTC). */
function slotAt(minute: number): Date {
  const hours = 1_000 + Math.floor(Math.random() * 100_000);

  return new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000 + minute * 60_000);
}

async function clusterRows(ts: Date) {
  return prisma.$queryRaw<
    Array<{ role: string; replica: string; metrics: Record<string, unknown> }>
  >`SELECT role, replica, metrics FROM ops_sample WHERE role = 'cluster' AND ts = ${ts}`;
}

describe("the cluster row of the ops heartbeat", () => {
  it("is written once a minute however many replicas fire", async () => {
    const slot = slotAt(7);

    await Promise.all([
      replicaA.runExclusively(heartbeat, slot),
      replicaB.runExclusively(heartbeat, slot),
    ]);

    const rows = await clusterRows(slot);

    expect(rows).toHaveLength(1);
    expect(rows[0].metrics).toMatchObject({
      v: 1,
      queues: expect.any(Object),
      database: {
        connection_usage_percent: expect.any(Number),
        xid_age: expect.any(Number),
        archive_mode: "off",
        pg_wal: { readable: true },
        pg_stat_statements: "ready",
        collection_errors: [],
      },
      redis: { status: "up" },
    });

    // The per-minute row stays small: the sizes ride on quarter-hours.
    expect(rows[0].metrics.database).not.toHaveProperty("sizes");

    const [{ runs }] = await prisma.$queryRaw<Array<{ runs: number }>>`
      SELECT count(*)::int AS runs FROM scheduled_job_execution
      WHERE "jobName" = 'ops-heartbeat' AND "scheduledFor" = ${slot}
        AND status = 'SUCCEEDED'
    `;

    expect(runs).toBe(1);
  });

  it("carries the sizes and the hot tables on a quarter-hour", async () => {
    const slot = slotAt(45);

    await replicaA.runExclusively(heartbeat, slot);

    const [row] = await clusterRows(slot);
    const database = row.metrics.database as Record<string, unknown>;

    expect(database.sizes).toMatchObject({
      database_bytes: expect.any(Number),
    });
    expect(database.hot_tables).toContainEqual(
      expect.objectContaining({ table: "driver_position" }),
    );
  });
});
