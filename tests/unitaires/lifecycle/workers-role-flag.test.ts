import { afterEach, describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { env } from "@/env";

import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";

/**
 * The switch that takes the background workers off a replica (GAP2-3).
 *
 * Every replica ran the pipelines, the webhook dispatcher and the cron on the
 * same process and the same 10-connection pool as the HTTP it serves. ADR
 * 0004 names the way out: the same image with the workers switched off on
 * the HTTP replicas and a worker service of its own. The switch did not
 * exist, so that step would have been code written under pressure.
 *
 * The default changes nothing: every replica keeps running its workers.
 */
vi.mock("@/../infra/database", () => ({ default: {} }));
vi.mock("@/websocket", () => ({
  sendAIVerificationEvent: vi.fn(),
  sendNotificationToUser: vi.fn(),
}));

/** The minimum a development boot needs. */
const BASE_ENV = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string>) => {
  const parsed = envSchema.safeParse({ ...BASE_ENV, ...overrides });

  if (!parsed.success) throw parsed.error;

  return parsed.data as unknown as {
    WORKERS_ENABLED: boolean;
    PIPELINE_SWEEP_INTERVAL_MS: number;
  };
};

const mutableEnv = env as unknown as {
  WORKERS_ENABLED: boolean;
  WORKER_QUEUES: readonly string[];
};
const original = { ...mutableEnv };

afterEach(() => {
  mutableEnv.WORKERS_ENABLED = original.WORKERS_ENABLED;
  mutableEnv.WORKER_QUEUES = original.WORKER_QUEUES;
  vi.restoreAllMocks();
});

describe("WORKERS_ENABLED", () => {
  it("is on unless a replica is told otherwise, empty included", () => {
    expect(parse({}).WORKERS_ENABLED).toBe(true);
    expect(parse({ WORKERS_ENABLED: "" }).WORKERS_ENABLED).toBe(true);
    expect(parse({ WORKERS_ENABLED: "false" }).WORKERS_ENABLED).toBe(false);
  });

  it("keeps the 30 s sweep unless a dedicated worker asks for a faster one", () => {
    expect(parse({}).PIPELINE_SWEEP_INTERVAL_MS).toBe(30_000);

    // The worker preset remembers it (plano-escala F3-01): the 30 s left by
    // a forgotten variable made every notification wait half a minute.
    expect(parse({ PROCESS_ROLE: "worker" }).PIPELINE_SWEEP_INTERVAL_MS).toBe(
      2_000,
    );
    expect(
      parse({ PIPELINE_SWEEP_INTERVAL_MS: "2000" }).PIPELINE_SWEEP_INTERVAL_MS,
    ).toBe(2_000);

    expect(
      envSchema.safeParse({ ...BASE_ENV, PIPELINE_SWEEP_INTERVAL_MS: "10" })
        .success,
    ).toBe(false);
  });
});

describe("a publish on a replica whose workers are off", () => {
  it("does not drain the notification pipeline there: the worker's sweep does", () => {
    const pipeline = NotificationPipelineService.getInstance() as unknown as {
      wake: () => void;
      runOutboxCycle: () => Promise<void>;
      runDeliveryCycle: () => Promise<void>;
    };

    const cycle = vi
      .spyOn(pipeline, "runOutboxCycle")
      .mockResolvedValue(undefined);

    vi.spyOn(pipeline, "runDeliveryCycle").mockResolvedValue(undefined);

    mutableEnv.WORKERS_ENABLED = false;
    pipeline.wake();

    expect(cycle).not.toHaveBeenCalled();

    mutableEnv.WORKERS_ENABLED = true;
    pipeline.wake();

    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it("does not drain the AI pipeline there either", () => {
    const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
      wake: () => void;
      runCycle: () => Promise<void>;
    };

    const cycle = vi.spyOn(pipeline, "runCycle").mockResolvedValue(undefined);

    mutableEnv.WORKERS_ENABLED = false;
    pipeline.wake();

    expect(cycle).not.toHaveBeenCalled();

    mutableEnv.WORKERS_ENABLED = true;
    pipeline.wake();

    expect(cycle).toHaveBeenCalledTimes(1);
  });
});

describe("a wake on a process that claims only some queues (WORKER_QUEUES)", () => {
  function notificationPipeline() {
    const pipeline = NotificationPipelineService.getInstance() as unknown as {
      wake: () => void;
      runOutboxCycle: () => Promise<boolean>;
      runDeliveryCycle: (lane: string) => Promise<void>;
    };

    const outbox = vi
      .spyOn(pipeline, "runOutboxCycle")
      .mockResolvedValue(false);
    const lanes = vi
      .spyOn(pipeline, "runDeliveryCycle")
      .mockResolvedValue(undefined);

    return { pipeline, outbox, lanes };
  }

  it("runs only the external lane on a worker-external", async () => {
    const { pipeline, outbox, lanes } = notificationPipeline();

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["external"];
    pipeline.wake();

    await vi.waitFor(() => expect(lanes).toHaveBeenCalled());

    expect(outbox).not.toHaveBeenCalled();
    expect(lanes.mock.calls).toEqual([["external"]]);
  });

  it("chains the outbox into the lanes this process claims, and no other", async () => {
    const { pipeline, outbox, lanes } = notificationPipeline();

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["outbox", "internal"];
    pipeline.wake();

    await vi.waitFor(() => expect(lanes).toHaveBeenCalled());

    expect(outbox).toHaveBeenCalledTimes(1);
    expect(lanes.mock.calls).toEqual([["internal"]]);
  });

  it("does nothing where none of its queues is claimed", () => {
    const { pipeline, outbox, lanes } = notificationPipeline();

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["webhooks", "ai"];
    pipeline.wake();

    expect(outbox).not.toHaveBeenCalled();
    expect(lanes).not.toHaveBeenCalled();
  });

  it("leaves the AI readings alone without the ai queue", () => {
    const pipeline = AIAnalysisPipelineService.getInstance() as unknown as {
      wake: () => void;
      runCycle: () => Promise<void>;
    };

    const cycle = vi.spyOn(pipeline, "runCycle").mockResolvedValue(undefined);

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["outbox", "internal", "external"];
    pipeline.wake();

    expect(cycle).not.toHaveBeenCalled();

    mutableEnv.WORKER_QUEUES = ["ai"];
    pipeline.wake();

    expect(cycle).toHaveBeenCalledTimes(1);
  });
});
