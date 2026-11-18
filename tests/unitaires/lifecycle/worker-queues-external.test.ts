import { afterEach, describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { env } from "@/env";

import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";

/**
 * A worker-external claims the external lane and nothing else (plano-escala
 * F3-01, the test F5-27 asked for).
 *
 * The role exists for one trigger: e-mail and WhatsApp sends, slow and
 * rate-limited by their providers, holding the batch of a worker that also
 * owns the bell and the push. Split off, a worker-external that still swept
 * the outbox or the internal lane would claim them on its own clock and its
 * own pool — the very contention the split removes — and the worker would
 * keep sending e-mail on its sweep. So its timers are per queue: only the
 * external lane's sweep exists in it, at the dedicated 2 s.
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

const mutableEnv = env as unknown as {
  WORKERS_ENABLED: boolean;
  WORKER_QUEUES: readonly string[];
};
const original = { ...mutableEnv };

afterEach(async () => {
  await NotificationPipelineService.getInstance().shutdown({ deadlineMs: 0 });

  mutableEnv.WORKERS_ENABLED = original.WORKERS_ENABLED;
  mutableEnv.WORKER_QUEUES = original.WORKER_QUEUES;

  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PROCESS_ROLE=worker-external", () => {
  it("resolves to the external lane alone, no cron, the 2 s sweep and /health only", () => {
    const parsed = envSchema.safeParse({
      ...BASE_ENV,
      PROCESS_ROLE: "worker-external",
    });

    if (!parsed.success) throw parsed.error;

    expect(parsed.data).toMatchObject({
      WORKERS_ENABLED: true,
      CRON_ENABLED: false,
      WORKER_QUEUES: ["external"],
      PIPELINE_SWEEP_INTERVAL_MS: 2_000,
      HTTP_SURFACE: "health",
    });
  });

  it("sweeps only the external lane", async () => {
    const pipeline = NotificationPipelineService.getInstance() as unknown as {
      initialize: () => Promise<void>;
      runOutboxCycle: () => Promise<boolean>;
      runDeliveryCycle: (lane: string) => Promise<void>;
    };

    const outbox = vi
      .spyOn(pipeline, "runOutboxCycle")
      .mockResolvedValue(false);
    const lanes = vi
      .spyOn(pipeline, "runDeliveryCycle")
      .mockResolvedValue(undefined);

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["external"];

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await pipeline.initialize();

    // Three sweeps of whatever interval this file's process resolved.
    vi.advanceTimersByTime(env.PIPELINE_SWEEP_INTERVAL_MS * 3);

    expect(outbox).not.toHaveBeenCalled();
    expect(lanes.mock.calls).toEqual([
      ["external"],
      ["external"],
      ["external"],
    ]);
  });

  it("is not the worker's: the worker without external keeps the outbox and the internal lane", async () => {
    const pipeline = NotificationPipelineService.getInstance() as unknown as {
      initialize: () => Promise<void>;
      runOutboxCycle: () => Promise<boolean>;
      runDeliveryCycle: (lane: string) => Promise<void>;
    };

    const outbox = vi
      .spyOn(pipeline, "runOutboxCycle")
      .mockResolvedValue(false);
    const lanes = vi
      .spyOn(pipeline, "runDeliveryCycle")
      .mockResolvedValue(undefined);

    mutableEnv.WORKERS_ENABLED = true;
    mutableEnv.WORKER_QUEUES = ["outbox", "internal", "webhooks", "ai", "jobs"];

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await pipeline.initialize();
    vi.advanceTimersByTime(env.PIPELINE_SWEEP_INTERVAL_MS);

    expect(outbox).toHaveBeenCalledTimes(1);
    expect(lanes.mock.calls).toEqual([["internal"]]);
  });
});
