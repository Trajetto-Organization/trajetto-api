import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * A stopping scheduler starts no new catch-up run (GAP6-9, OBS-10).
 *
 * The catch-up sweep runs the jobs that missed their window one after the
 * other. shutdown() waits for the run in flight — but the sweep went on to
 * the next job the moment that run finished, claiming and starting it while
 * the process was on its way out. Killed mid-run, that one stayed RUNNING
 * until its lease expired and was written off as FAILED: a clean deploy
 * reported as a crashed job, and the work redone an hour later.
 */
const claims: string[] = [];

vi.mock("@/../infra/database", () => ({
  default: {
    scheduledJobExecution: {
      create: vi.fn(async ({ data }: { data: { jobName: string } }) => {
        claims.push(data.jobName);
        return { id: `row-${data.jobName}`, ...data };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      // Nothing succeeded in any window: every daily job needs catching up.
      findFirst: vi.fn(async () => null),
    },
  },
}));

vi.mock("node-cron", () => ({
  default: {
    validate: () => true,
    schedule: vi.fn(() => ({ stop: vi.fn() })),
  },
}));

type Scheduler = {
  registerJob(definition: CronJobDefinition): void;
  initialize(): Promise<void>;
  catchUp(now?: Date): Promise<void>;
  shutdown(): Promise<void>;
};

async function freshScheduler(): Promise<Scheduler> {
  const { CronSchedulerService } = await import(
    "@/shared/services/cron-scheduler-service"
  );

  return new (CronSchedulerService as unknown as new () => Scheduler)();
}

beforeEach(() => {
  claims.length = 0;

  vi.useFakeTimers({ now: new Date("2026-09-24T10:07:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the catch-up sweep during shutdown", () => {
  it("lets the run in flight finish and starts no other", async () => {
    const scheduler = await freshScheduler();

    let secondRan = false;

    scheduler.registerJob({
      name: "cleanup-expired-refresh-tokens",
      schedule: "17 3 * * *",
      handler: () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    });

    scheduler.registerJob({
      name: "cleanup-notification-pipeline",
      schedule: "30 3 * * *",
      handler: async () => {
        secondRan = true;
      },
    });

    await scheduler.initialize();

    const sweep = scheduler.catchUp();

    // The first job is claimed and its handler is running.
    await vi.advanceTimersByTimeAsync(10);
    expect(claims).toEqual(["cleanup-expired-refresh-tokens"]);

    const stopping = scheduler.shutdown();

    await vi.advanceTimersByTimeAsync(1_100);
    await stopping;
    await sweep;

    expect(secondRan, "a new run started after shutdown began").toBe(false);
    expect(claims).toEqual(["cleanup-expired-refresh-tokens"]);
  });

  it("does nothing when it fires after shutdown", async () => {
    const scheduler = await freshScheduler();

    let ran = false;

    scheduler.registerJob({
      name: "driver-position-partitions",
      schedule: "10 4 * * *",
      handler: async () => {
        ran = true;
      },
    });

    await scheduler.initialize();
    await scheduler.shutdown();

    await scheduler.catchUp();

    expect(ran).toBe(false);
    expect(claims).toEqual([]);
  });

  it("sweeps again once the scheduler is initialized again", async () => {
    const scheduler = await freshScheduler();

    let runs = 0;

    scheduler.registerJob({
      name: "cleanup-user-history",
      schedule: "0 4 * * *",
      handler: async () => {
        runs += 1;
      },
    });

    await scheduler.initialize();
    await scheduler.shutdown();
    await scheduler.initialize();

    await scheduler.catchUp();

    expect(runs).toBe(1);

    await scheduler.shutdown();
  });
});
