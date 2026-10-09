import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * Shutdown waits for a cron run in flight (OBS-10).
 *
 * shutdown() stopped the node-cron tasks and returned; the server then called
 * process.exit while a purge or the partitions job was halfway through. The
 * run never recorded how it ended, so its row stayed RUNNING until its lease
 * expired and the catch-up sweep (GAP6-9) wrote it off as FAILED — a clean
 * deploy reported as a crashed job, and the work redone hours later. Now
 * shutdown gives the run in flight a bounded wait to finish and record
 * itself.
 */
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/../infra/database", () => ({
  default: {
    scheduledJobExecution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "row",
        attempts: 1,
        ...data,
      })),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      }),
      findFirst: vi.fn(async () => ({ id: "covered" })),
    },
  },
}));

const scheduled: Array<() => Promise<unknown>> = [];

vi.mock("node-cron", () => ({
  default: {
    validate: () => true,
    schedule: vi.fn((_expression: string, fn: () => Promise<unknown>) => {
      scheduled.push(fn);
      return { stop: vi.fn() };
    }),
  },
}));

type Scheduler = {
  registerJob(definition: CronJobDefinition): void;
  registeredJobs(): Array<{ name: string; schedule: string }>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
};

async function freshScheduler(): Promise<Scheduler> {
  const { CronSchedulerService } = await import(
    "@/shared/services/cron-scheduler-service"
  );

  return new (CronSchedulerService as unknown as new () => Scheduler)();
}

beforeEach(() => {
  updates.length = 0;
  scheduled.length = 0;

  vi.useFakeTimers({ now: new Date("2026-09-24T04:10:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CronSchedulerService.shutdown", () => {
  it("waits for the run in flight to finish and record itself", async () => {
    const scheduler = await freshScheduler();

    let finished = false;

    scheduler.registerJob({
      name: "driver-position-partitions",
      schedule: "10 4 * * *",
      handler: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 1_000),
        ),
    });

    await scheduler.initialize();

    const firing = scheduled[0]();

    // The claim lands and the handler starts.
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopping = scheduler.shutdown().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(stopped, "shutdown returned with the run still going").toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    await stopping;
    await firing;

    expect(finished).toBe(true);

    expect(
      updates.some(
        (args) => (args.data as { status?: string } | undefined)?.status === "SUCCEEDED",
      ),
      "the run did not record how it ended before shutdown returned",
    ).toBe(true);
  });

  it("does not wait forever for a run that hangs", async () => {
    const scheduler = await freshScheduler();

    scheduler.registerJob({
      name: "stuck",
      schedule: "0 4 * * *",
      handler: () => new Promise<void>(() => {}),
    });

    await scheduler.initialize();

    void scheduled[0]();
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopping = scheduler.shutdown().then(() => {
      stopped = true;
    });

    // Under the 35 s shutdown watchdog of server.ts, with room to spare.
    await vi.advanceTimersByTimeAsync(15_000);
    await stopping;

    expect(stopped).toBe(true);
  });
});

describe("CronSchedulerService.registeredJobs", () => {
  it("lists what this process schedules, for /health/metrics", async () => {
    const scheduler = await freshScheduler();

    scheduler.registerJob({
      name: "cleanup-notification-pipeline",
      schedule: "30 3 * * *",
      handler: async () => {},
    });

    expect(scheduler.registeredJobs()).toEqual([
      { name: "cleanup-notification-pipeline", schedule: "30 3 * * *" },
    ]);
  });
});
