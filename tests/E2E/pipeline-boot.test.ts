import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The backlog a replica finds at boot is drained only once realtime exists.
 *
 * `initializeWorkers()` ran before `initializeSocketIO()`, and both pipelines
 * drained right inside their `initialize()`. Everything that piled up during
 * a deploy was therefore delivered while `io` was still undefined: the in-app
 * rows became DELIVERED with no toast — "Socket.IO is not initialized yet" in
 * the log — on this replica and every other one, because the Redis adapter
 * did not exist yet either (OUTBOX-19). The drain is now a separate step the
 * boot runs after realtime (see shared/lifecycle/startup.ts).
 *
 * Its own file: shutdown() leaves a pipeline stopping, which must not leak
 * into the files that drive cycles by hand.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("starting a pipeline", () => {
  it("does not drain the notification backlog on its own", async () => {
    const { NotificationPipelineService } =
      await import("@/shared/notifications/notification-pipeline-service");

    const pipeline = NotificationPipelineService.getInstance();
    const cycle = vi.spyOn(pipeline, "runOutboxCycle").mockResolvedValue(false);

    await pipeline.initialize();
    await settle();

    try {
      expect(cycle).not.toHaveBeenCalled();
    } finally {
      await pipeline.shutdown();
    }
  });

  it("does not drain the AI analysis backlog on its own", async () => {
    const { AIAnalysisPipelineService } =
      await import("@/shared/ai/ai-analysis-pipeline-service");

    const pipeline = AIAnalysisPipelineService.getInstance();

    const internals = pipeline as unknown as { runCycle: () => Promise<void> };
    const cycle = vi.spyOn(internals, "runCycle").mockResolvedValue(undefined);

    await pipeline.initialize();
    await settle();

    try {
      expect(cycle).not.toHaveBeenCalled();
    } finally {
      await pipeline.shutdown();
    }
  });

  it("drains both when the boot says so", async () => {
    const { NotificationPipelineService } =
      await import("@/shared/notifications/notification-pipeline-service");
    const { AIAnalysisPipelineService } =
      await import("@/shared/ai/ai-analysis-pipeline-service");
    const { drainWorkerBacklog } = await import("@/workers");

    const notifications = vi
      .spyOn(NotificationPipelineService.getInstance(), "runOutboxCycle")
      .mockResolvedValue(false);

    const ai = vi
      .spyOn(
        AIAnalysisPipelineService.getInstance() as unknown as {
          runCycle: () => Promise<void>;
        },
        "runCycle",
      )
      .mockResolvedValue(undefined);

    // As the boot does it: armed first, drained after realtime.
    await NotificationPipelineService.getInstance().initialize();
    await AIAnalysisPipelineService.getInstance().initialize();

    try {
      drainWorkerBacklog();
      await settle();

      expect(notifications).toHaveBeenCalled();
      expect(ai).toHaveBeenCalled();
    } finally {
      await NotificationPipelineService.getInstance().shutdown();
      await AIAnalysisPipelineService.getInstance().shutdown();
    }
  });
});

/**
 * A process that claims only some queues (WORKER_QUEUES, plano-escala F3-01)
 * drains only those at boot: a worker-external drained the bell's backlog
 * and the AI readings on its own pool, the contention the split removes.
 */
describe("draining with a subset of the queues", () => {
  it("drains the lanes it claims and leaves the AI readings to their worker", async () => {
    const { env } = await import("@/env");
    const { NotificationPipelineService } =
      await import("@/shared/notifications/notification-pipeline-service");
    const { AIAnalysisPipelineService } =
      await import("@/shared/ai/ai-analysis-pipeline-service");
    const { drainWorkerBacklog } = await import("@/workers");

    const mutableEnv = env as unknown as { WORKER_QUEUES: readonly string[] };
    const queues = mutableEnv.WORKER_QUEUES;

    const notifications = NotificationPipelineService.getInstance();
    const outbox = vi
      .spyOn(notifications, "runOutboxCycle")
      .mockResolvedValue(false);
    const lanes = vi
      .spyOn(notifications, "runDeliveryCycle")
      .mockResolvedValue(undefined);
    const ai = vi
      .spyOn(
        AIAnalysisPipelineService.getInstance() as unknown as {
          runCycle: () => Promise<void>;
        },
        "runCycle",
      )
      .mockResolvedValue(undefined);

    mutableEnv.WORKER_QUEUES = ["external"];

    await notifications.initialize();

    try {
      drainWorkerBacklog();
      await settle();

      expect(outbox).not.toHaveBeenCalled();
      expect(lanes.mock.calls).toEqual([["external"]]);
      expect(ai).not.toHaveBeenCalled();
    } finally {
      mutableEnv.WORKER_QUEUES = queues;
      await notifications.shutdown();
    }
  });
});
