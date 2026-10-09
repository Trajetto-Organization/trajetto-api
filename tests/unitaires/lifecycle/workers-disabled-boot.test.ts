import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

/**
 * A replica booted with WORKERS_ENABLED=false (GAP2-3).
 *
 * It serves HTTP and realtime and nothing else: no cron, no pipeline timers,
 * no boot drain. The API usage recorder is the exception — it is fed by the
 * HTTP requests of the integration API, so it runs wherever those are served.
 */
const calls: string[] = [];

vi.mock("@/shared/services/cron-scheduler-service", () => ({
  CronSchedulerService: {
    getInstance: () => ({
      initialize: async () => {
        calls.push("cron");
      },
      shutdown: async () => undefined,
    }),
  },
}));

vi.mock("@/jobs/cron", () => ({
  registerCronJobs: () => {
    calls.push("registerCronJobs");
  },
}));

const pipeline = (name: string) => ({
  getInstance: () => ({
    initialize: async () => {
      calls.push(`${name}.initialize`);
    },
    wake: () => {
      calls.push(`${name}.wake`);
    },
    shutdown: async () => undefined,
  }),
});

vi.mock("@/shared/notifications/notification-pipeline-service", () => ({
  NotificationPipelineService: pipeline("notifications"),
}));

vi.mock("@/shared/ai/ai-analysis-pipeline-service", () => ({
  AIAnalysisPipelineService: pipeline("ai"),
}));

vi.mock("@/shared/integration/webhook-dispatch-service", () => ({
  WebhookDispatchService: pipeline("webhooks"),
}));

vi.mock("@/shared/integration/api-usage-recorder", () => ({
  apiUsageRecorder: {
    initialize: () => {
      calls.push("apiUsageRecorder");
    },
    shutdown: async () => undefined,
  },
}));

vi.mock("@/shared/health/worker-heartbeat", () => ({
  startHeartbeatFlush: () => {
    calls.push("heartbeat");
    return () => undefined;
  },
}));

const mutableEnv = env as unknown as { WORKERS_ENABLED: boolean };
const original = mutableEnv.WORKERS_ENABLED;

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  mutableEnv.WORKERS_ENABLED = original;
});

describe("a replica with its workers switched off", () => {
  it("starts only what its own HTTP requests feed, and drains nothing", async () => {
    mutableEnv.WORKERS_ENABLED = false;

    const { drainWorkerBacklog, initializeWorkers } = await import(
      "@/workers"
    );

    await initializeWorkers();
    drainWorkerBacklog();

    expect(calls).toEqual(["apiUsageRecorder"]);
  });
});

describe("a replica with its workers on (the default)", () => {
  it("starts everything, as before", async () => {
    mutableEnv.WORKERS_ENABLED = true;

    const { drainWorkerBacklog, initializeWorkers } = await import(
      "@/workers"
    );

    await initializeWorkers();
    drainWorkerBacklog();

    expect(calls).toEqual(
      expect.arrayContaining([
        "registerCronJobs",
        "cron",
        "apiUsageRecorder",
        "notifications.initialize",
        "ai.initialize",
        "webhooks.initialize",
        "heartbeat",
        "notifications.wake",
        "ai.wake",
      ]),
    );
  });
});
