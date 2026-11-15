import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workers stop within the deadline the shutdown plan gives them
 * (plano-escala F1-14).
 *
 * Each worker waited for its batch in flight with a deadline of its own —
 * 10 s for the pipelines and the cron, 12 s for the webhook dispatcher —
 * sized for the 35 s watchdog of a 40 s grace. With Docker's default 10 s
 * grace those waits alone outlived the SIGKILL. The plan now hands one
 * deadline to all of them, which can only shorten their own: with the 40 s
 * grace nothing changes, with 10 s they are done in 3 s. What a deadline
 * cuts short is recovered by the leases, as before.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    scheduledJobExecution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "row",
        attempts: 1,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: "covered" })),
    },
  },
}));
vi.mock("@/websocket", () => ({
  sendAIVerificationEvent: vi.fn(),
  sendNotificationToUser: vi.fn(),
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

type Stoppable = {
  shutdown(options?: { deadlineMs?: number }): Promise<void>;
};

/** When `shutdown` settles, in fake ms from the call; null if it did not. */
async function settlesAt(
  stoppable: Stoppable,
  options: { deadlineMs?: number } | undefined,
  horizonMs: number,
): Promise<number | null> {
  const started = Date.now();
  let settledAt: number | null = null;

  void stoppable.shutdown(options).then(() => {
    settledAt = Date.now() - started;
  });

  await vi.advanceTimersByTimeAsync(horizonMs);

  return settledAt;
}

/** A worker caught in the middle of a batch that never ends. */
async function busyNotificationPipeline(): Promise<Stoppable> {
  const { NotificationPipelineService } =
    await import("@/shared/notifications/notification-pipeline-service");

  const pipeline = new (
    NotificationPipelineService as unknown as new () => {
      outboxRunning: boolean;
    }
  )();
  pipeline.outboxRunning = true;

  return pipeline as unknown as Stoppable;
}

async function busyAIPipeline(): Promise<Stoppable> {
  const { AIAnalysisPipelineService } =
    await import("@/shared/ai/ai-analysis-pipeline-service");

  const pipeline = new (
    AIAnalysisPipelineService as unknown as new () => {
      running: boolean;
    }
  )();
  pipeline.running = true;

  return pipeline as unknown as Stoppable;
}

async function busyWebhookDispatcher(): Promise<Stoppable> {
  const { WebhookDispatchService } =
    await import("@/shared/integration/webhook-dispatch-service");

  const dispatcher = new WebhookDispatchService() as unknown as {
    running: boolean;
  };
  dispatcher.running = true;

  return dispatcher as unknown as Stoppable;
}

async function busyCron(): Promise<Stoppable> {
  const { CronSchedulerService } =
    await import("@/shared/services/cron-scheduler-service");

  const scheduler = new (
    CronSchedulerService as unknown as new () => {
      registerJob(definition: unknown): void;
      initialize(): Promise<void>;
    }
  )();

  scheduler.registerJob({
    name: "stuck",
    schedule: "0 4 * * *",
    handler: () => new Promise<void>(() => {}),
  });

  // The job's task is the first one initialize() schedules (the catch-up
  // sweep comes after it).
  const job = scheduled.length;

  await scheduler.initialize();

  void scheduled[job]();
  await vi.advanceTimersByTimeAsync(10);

  return scheduler as unknown as Stoppable;
}

beforeEach(() => {
  scheduled.length = 0;
  vi.useFakeTimers({ now: new Date("2026-11-15T04:10:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["notification pipeline", busyNotificationPipeline, 10_000],
  ["AI analysis pipeline", busyAIPipeline, 10_000],
  ["webhook dispatcher", busyWebhookDispatcher, 12_000],
  ["cron scheduler", busyCron, 10_000],
] as const)("%s shutdown", (_name, busy, ownDeadlineMs) => {
  it("stops at the plan's deadline when it is shorter than its own", async () => {
    const at = await settlesAt(await busy(), { deadlineMs: 3_000 }, 5_000);

    expect(at).not.toBeNull();
    expect(at as unknown as number).toBeGreaterThanOrEqual(3_000);
    expect(at as unknown as number).toBeLessThan(3_100);
  });

  it("keeps its own deadline without a plan, and a longer plan never stretches it", async () => {
    for (const options of [undefined, { deadlineMs: 60_000 }]) {
      const at = await settlesAt(await busy(), options, ownDeadlineMs + 1_000);

      expect(at, JSON.stringify(options)).not.toBeNull();
      expect(at as unknown as number).toBeGreaterThanOrEqual(ownDeadlineMs);
      expect(at as unknown as number).toBeLessThan(ownDeadlineMs + 100);
    }
  });
});

describe("shutdownWorkers", () => {
  it("hands the plan's deadline to every worker", async () => {
    const [
      { NotificationPipelineService },
      { AIAnalysisPipelineService },
      { WebhookDispatchService },
      { CronSchedulerService },
      { apiUsageRecorder },
      geocoding,
    ] = await Promise.all([
      import("@/shared/notifications/notification-pipeline-service"),
      import("@/shared/ai/ai-analysis-pipeline-service"),
      import("@/shared/integration/webhook-dispatch-service"),
      import("@/shared/services/cron-scheduler-service"),
      import("@/shared/integration/api-usage-recorder"),
      import("@/shared/delivery/geocoding/geocode-soon"),
    ]);

    const spies = [
      vi
        .spyOn(NotificationPipelineService.getInstance(), "shutdown")
        .mockResolvedValue(undefined),
      vi
        .spyOn(AIAnalysisPipelineService.getInstance(), "shutdown")
        .mockResolvedValue(undefined),
      vi
        .spyOn(WebhookDispatchService.getInstance(), "shutdown")
        .mockResolvedValue(undefined),
      vi
        .spyOn(CronSchedulerService.getInstance(), "shutdown")
        .mockResolvedValue(undefined),
    ];

    vi.spyOn(apiUsageRecorder, "shutdown").mockResolvedValue(undefined);
    vi.spyOn(geocoding, "shutdownDeliveryGeocoding").mockResolvedValue(
      undefined,
    );

    const { shutdownWorkers } = await import("@/workers");

    await shutdownWorkers({ deadlineMs: 3_000 });

    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith({ deadlineMs: 3_000 });
    }
  });
});
