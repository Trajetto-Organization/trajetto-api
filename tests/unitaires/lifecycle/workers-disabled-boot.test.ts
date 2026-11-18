import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

/**
 * A replica booted with WORKERS_ENABLED=false (GAP2-3), and the roles that
 * claim only some queues or no cron (plano-escala F3-01).
 *
 * An HTTP-only replica serves HTTP and realtime and nothing else: no cron,
 * no pipeline timers, no boot drain. The API usage recorder is the
 * exception — it is fed by the HTTP requests of the integration API, so it
 * runs wherever those are served. The cron's registry is filled on every
 * process (/health/metrics lists the jobs whichever replica answers); only
 * CRON_ENABLED schedules it. Each pipeline starts, and drains at boot, only
 * where WORKER_QUEUES names its queues.
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

const mutableEnv = env as unknown as {
  WORKERS_ENABLED: boolean;
  CRON_ENABLED: boolean;
  WORKER_QUEUES: readonly string[];
};
const original = { ...mutableEnv };

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  mutableEnv.WORKERS_ENABLED = original.WORKERS_ENABLED;
  mutableEnv.CRON_ENABLED = original.CRON_ENABLED;
  mutableEnv.WORKER_QUEUES = original.WORKER_QUEUES;
});

/** As the env schema resolves a role (shared/lifecycle/process-role.ts). */
function boot(settings: {
  workers: boolean;
  cron: boolean;
  queues: readonly string[];
}) {
  mutableEnv.WORKERS_ENABLED = settings.workers;
  mutableEnv.CRON_ENABLED = settings.cron;
  mutableEnv.WORKER_QUEUES = settings.queues;
}

describe("a replica with its workers switched off", () => {
  it("starts only what its own HTTP requests feed, and drains nothing", async () => {
    mutableEnv.WORKERS_ENABLED = false;

    const { drainWorkerBacklog, initializeWorkers } = await import("@/workers");

    await initializeWorkers();
    drainWorkerBacklog();

    expect(calls).toEqual(["apiUsageRecorder", "registerCronJobs"]);
  });
});

describe("a scheduler (the cron and no queue)", () => {
  it("schedules the cron and starts no pipeline, nor drains one", async () => {
    boot({ workers: true, cron: true, queues: [] });

    const { drainWorkerBacklog, initializeWorkers } = await import("@/workers");

    await initializeWorkers();
    drainWorkerBacklog();

    expect(calls).toEqual([
      "apiUsageRecorder",
      "registerCronJobs",
      "cron",
      "heartbeat",
    ]);
  });
});

describe("a worker-external (the external lane only, no cron)", () => {
  it("starts the notification pipeline alone and drains only it", async () => {
    boot({ workers: true, cron: false, queues: ["external"] });

    const { drainWorkerBacklog, initializeWorkers } = await import("@/workers");

    await initializeWorkers();
    drainWorkerBacklog();

    expect(calls).toEqual([
      "apiUsageRecorder",
      "registerCronJobs",
      "notifications.initialize",
      "heartbeat",
      "notifications.wake",
    ]);
  });
});

describe("a worker without the cron (once a scheduler exists)", () => {
  it("starts every queue's service and no cron", async () => {
    boot({
      workers: true,
      cron: false,
      queues: ["outbox", "internal", "webhooks", "ai", "jobs"],
    });

    const { initializeWorkers } = await import("@/workers");

    await initializeWorkers();

    expect(calls).not.toContain("cron");
    expect(calls).toEqual(
      expect.arrayContaining([
        "notifications.initialize",
        "ai.initialize",
        "webhooks.initialize",
      ]),
    );
  });
});

describe("a replica with its workers on (the default)", () => {
  it("starts everything, as before", async () => {
    boot({
      workers: true,
      cron: true,
      queues: ["outbox", "internal", "external", "webhooks", "ai", "jobs"],
    });

    const { drainWorkerBacklog, initializeWorkers } = await import("@/workers");

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
