import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A nightly job whose firing was lost comes back the same day (GAP6-9).
 *
 * Every job is daily (03:17 to 04:50). The scheduler claims a firing by
 * inserting (jobName, scheduledFor) with scheduledFor truncated to the
 * minute, and the "takeover by lease" it advertised needed the SAME minute
 * with an expired ten-minute lease — which never happens. So:
 *
 * - Postgres down at 03:30: the claim throws, the firing is gone, and the
 *   purge waits for tomorrow;
 * - the replica dies mid-run: the row stays RUNNING forever and nobody runs
 *   the job again until the next night.
 *
 * The catch-up sweep (hourly, and once after boot) marks orphaned RUNNING
 * rows FAILED and runs any daily job with no success in its window, through
 * the same election, so replicas sweeping together still run it once.
 */
const prisma = createPrismaClient();

const HOUR_MS = 60 * 60 * 1000;

type Scheduler = {
  registerJob(definition: CronJobDefinition): void;
  catchUp(now?: Date): Promise<void>;
};

let Constructor: new () => Scheduler;

beforeAll(async () => {
  const { CronSchedulerService } = await import(
    "@/shared/services/cron-scheduler-service"
  );

  // One instance per "replica"; production keeps one per process.
  Constructor = CronSchedulerService as unknown as new () => Scheduler;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

function dailyJob(runs: { count: number }): CronJobDefinition {
  return {
    name: `catch-up-${randomUUID()}`,
    schedule: "30 3 * * *",
    handler: async () => {
      runs.count += 1;
    },
  };
}

function schedulerWith(definition: CronJobDefinition): Scheduler {
  const scheduler = new Constructor();

  scheduler.registerJob(definition);

  return scheduler;
}

describe("a daily job with no successful run in its window", () => {
  it("runs once when its firing was lost (no row at all)", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(1);

    const rows = await prisma.scheduledJobExecution.findMany({
      where: { jobName: job.name },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SUCCEEDED");
  });

  it("runs when the last success is older than the window", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    await prisma.scheduledJobExecution.create({
      data: {
        jobName: job.name,
        scheduledFor: new Date(Date.now() - 27 * HOUR_MS),
        status: "SUCCEEDED",
        finishedAt: new Date(Date.now() - 27 * HOUR_MS),
        leaseExpiresAt: new Date(Date.now() - 27 * HOUR_MS),
      },
    });

    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(1);
  });

  it("marks a run whose replica died as FAILED, and runs the job again", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    const orphan = await prisma.scheduledJobExecution.create({
      data: {
        jobName: job.name,
        scheduledFor: new Date(Date.now() - 7 * HOUR_MS),
        // Its ten minutes ran out hours ago.
        leaseExpiresAt: new Date(Date.now() - 7 * HOUR_MS + 10 * 60_000),
      },
    });

    await schedulerWith(job).catchUp();

    const after = await prisma.scheduledJobExecution.findUniqueOrThrow({
      where: { id: orphan.id },
    });

    expect(after.status).toBe("FAILED");
    expect(after.finishedAt).not.toBeNull();
    expect(after.lastError).toBeTruthy();

    expect(runs.count).toBe(1);
  });

  it("runs once when two replicas sweep in the same hour", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    await Promise.all([
      schedulerWith(job).catchUp(),
      schedulerWith(job).catchUp(),
    ]);

    // And a third sweep later in the same hour finds the fresh success.
    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(1);
  });
});

describe("a daily job that is covered", () => {
  it("is not run again when it succeeded within the window", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    await prisma.scheduledJobExecution.create({
      data: {
        jobName: job.name,
        scheduledFor: new Date(Date.now() - 20 * HOUR_MS),
        status: "SUCCEEDED",
        finishedAt: new Date(Date.now() - 20 * HOUR_MS),
        leaseExpiresAt: new Date(Date.now() - 20 * HOUR_MS),
      },
    });

    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(0);
  });

  it("is not run while another replica holds a live lease on it", async () => {
    const runs = { count: 0 };
    const job = dailyJob(runs);

    const running = await prisma.scheduledJobExecution.create({
      data: {
        jobName: job.name,
        scheduledFor: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(0);

    const after = await prisma.scheduledJobExecution.findUniqueOrThrow({
      where: { id: running.id },
    });

    expect(after.status).toBe("RUNNING");
  });
});

describe("a job that is not daily", () => {
  it("is left to its own next firing", async () => {
    const runs = { count: 0 };
    const job: CronJobDefinition = {
      name: `catch-up-${randomUUID()}`,
      // Every fifteen minutes: the next firing is the catch-up.
      schedule: "*/15 * * * *",
      handler: async () => {
        runs.count += 1;
      },
    };

    await schedulerWith(job).catchUp();

    expect(runs.count).toBe(0);
  });
});
