import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { createPrismaClient } from "@/shared/database/database-client";
import { PartialRunError } from "@/shared/errors/partial-run-error";

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
  const { CronSchedulerService } =
    await import("@/shared/services/cron-scheduler-service");

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

/**
 * A purge that stops with rows still due (plano-escala F1-17).
 *
 * It used to end SUCCEEDED: nothing ran it again before the next night, and
 * the backlog grew in silence. It now ends FAILED "[partial]", and the
 * sweep takes it again only inside the partial window (06:00–09:00 UTC by
 * default, after the 05:00 backups and before the morning), at most three
 * times a day — never through business hours. The sweep's clock is
 * injected: a day in the future, so no other row of the job is near it.
 */
describe("a purge that stops partial", () => {
  const DAY = "2027-03-10";
  const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

  type MutableEnv = { CRON_PURGE_RUN_BUDGET_MS: number };
  let mutableEnv: MutableEnv;
  let budget: number;
  let purge: CronJobDefinition;

  beforeAll(async () => {
    const { env } = await import("@/env");
    ({ cleanupNotificationPipelineJob: purge } =
      await import("@/jobs/cron/cleanup-notification-pipeline-job"));

    mutableEnv = env as unknown as MutableEnv;
    budget = mutableEnv.CRON_PURGE_RUN_BUDGET_MS;

    // A budget gone before the big purge starts: the small ones take more
    // than a millisecond between them.
    mutableEnv.CRON_PURGE_RUN_BUDGET_MS = 1;

    // Published events past their 30 days: due, and left by every run here.
    const processedAt = new Date(Date.now() - 40 * 24 * HOUR_MS);

    await prisma.domainOutboxEvent.createMany({
      data: Array.from({ length: 3 }, () => ({
        eventKey: `partial-purge-${randomUUID()}`,
        topic: "cron.partial",
        aggregateType: "cron",
        aggregateId: randomUUID(),
        payload: {},
        status: "PUBLISHED" as const,
        processedAt,
      })),
    });
  });

  afterAll(async () => {
    mutableEnv.CRON_PURGE_RUN_BUDGET_MS = budget;

    await prisma.domainOutboxEvent.deleteMany({
      where: { topic: "cron.partial" },
    });
  });

  it("ends partial when its budget runs out with rows still due", async () => {
    const outcome = await purge.handler().then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(PartialRunError);
    expect((outcome as Error).message).toMatch(
      /^\[partial\] .*domain_outbox_event \(PUBLISHED\)/,
    );

    // The small purges ran and had nothing left: they are not named.
    expect((outcome as PartialRunError).pending).toEqual([
      "domain_outbox_event (PUBLISHED)",
    ]);
  });

  it("is taken again at 06:07, 07:07 and 08:07, never at 04:07 nor 14:07", async () => {
    // Last night's run, partial.
    await prisma.scheduledJobExecution.create({
      data: {
        jobName: purge.name,
        scheduledFor: at("03:30"),
        status: "FAILED",
        finishedAt: at("03:35"),
        leaseExpiresAt: at("03:40"),
        lastError: "[partial] parou no orçamento ou no teto com sobra em: x",
      },
    });

    const scheduler = schedulerWith(purge);

    for (const time of ["04:07", "06:07", "07:07", "08:07", "08:37", "14:07"]) {
      await scheduler.catchUp(at(time));
    }

    const rows = await prisma.scheduledJobExecution.findMany({
      where: { jobName: purge.name, scheduledFor: { gte: at("00:00") } },
      orderBy: { scheduledFor: "asc" },
    });

    const hhmm = (row: { scheduledFor: Date }) =>
      row.scheduledFor.toISOString().slice(11, 16);

    expect(rows.map(hhmm)).toEqual(["03:30", "06:00", "07:00", "08:00"]);

    // Each retry still had rows due: partial again, FAILED, never SUCCEEDED.
    for (const row of rows) {
      expect(row.status).toBe("FAILED");
      expect(row.lastError).toMatch(/^\[partial\]/);
    }
  });
});
