import { afterEach, describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { env } from "@/env";
import {
  QUEUE_CONCURRENCY_DEFAULTS,
  QUEUE_CONCURRENCY_VARIABLES,
  poolHeadroomWarning,
} from "@/shared/lifecycle/queue-config";
import { DELIVERY_CONCURRENCY } from "@/shared/notifications/pipeline-rules";
import {
  WEBHOOK_CONCURRENCY,
  WEBHOOK_PER_ENDPOINT_CONCURRENCY,
} from "@/shared/integration/webhook-dispatch-rules";

/**
 * How many rows of each queue a process works on at once, by environment
 * (plano-escala F3-05).
 *
 * They were constants of each pipeline — 5 deliveries per lane, 5 webhooks,
 * 4 AI readings, one outbox event at a time — and one Application per role
 * needs them to follow the process: a dedicated worker has the whole pool,
 * a worker-external only waits on providers.
 *
 * What this pins:
 *  - without the variables, the very constants of before;
 *  - a value out of range fails the boot, and so does one too low for its
 *    batch to fit the lease: a batch that outlives its lease is reclaimed
 *    by another process while this one still sends it, and the recipient
 *    gets the message twice;
 *  - the pipelines really run that many at a time;
 *  - the database-only slots that take the whole pool are a warning.
 */

/**
 * Each case below loads a pipeline module anew (the pipeline, its
 * repositories, the logger): a second or two on a busy machine, past
 * vitest's 5 s when several files run beside it.
 */
const LOAD_TIMEOUT_MS = 30_000;

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

type Parsed = Record<string, unknown>;

function parse(overrides: Record<string, string> = {}) {
  return envSchema.safeParse({ ...BASE_ENV, ...overrides });
}

function issuePaths(overrides: Record<string, string>): string[] {
  const parsed = parse(overrides);

  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => String(issue.path[0]));
}

/**
 * A pipeline module loaded under an environment with `overrides`: its
 * constants and its load-time invariants read the values at import, as in
 * a process that boots with them.
 */
async function loadUnder<T>(
  path: string,
  overrides: Record<string, number>,
): Promise<T> {
  vi.resetModules();

  vi.doMock("@/env", () => ({ env: { ...env, ...overrides } }));
  vi.doMock("@/../infra/database", () => ({
    default: {
      domainOutboxEvent: { findMany: async () => [] },
    },
  }));
  vi.doMock("@/websocket", () => ({
    sendAIVerificationEvent: vi.fn(),
    sendNotificationToUser: vi.fn(),
  }));

  return (await import(path)) as T;
}

/** Calls `work` and reports the most of them that ran at the same time. */
function peakTracker() {
  let running = 0;
  let peak = 0;

  return {
    get peak() {
      return peak;
    },
    run: async () => {
      running++;
      peak = Math.max(peak, running);

      // Two turns of the loop, so the siblings get to start.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      running--;
    },
  };
}

afterEach(() => {
  vi.doUnmock("@/env");
  vi.doUnmock("@/../infra/database");
  vi.doUnmock("@/websocket");
  vi.resetModules();
});

describe("without the variables", () => {
  it("runs the constants of before, number for number", () => {
    const parsed = parse();

    if (!parsed.success) throw parsed.error;

    const data = parsed.data as unknown as Parsed;

    expect(
      Object.fromEntries(
        QUEUE_CONCURRENCY_VARIABLES.map((name) => [name, data[name]]),
      ),
    ).toEqual({
      NOTIFICATION_INTERNAL_CONCURRENCY: 5,
      NOTIFICATION_EXTERNAL_CONCURRENCY: 5,
      OUTBOX_EXPANSION_CONCURRENCY: 1,
      WEBHOOK_CONCURRENCY: 5,
      AI_CONCURRENCY: 4,
      WEBHOOK_PER_ENDPOINT_CONCURRENCY: 2,
    });

    // The pipelines' own defaults are the same numbers.
    expect(QUEUE_CONCURRENCY_DEFAULTS.NOTIFICATION_INTERNAL_CONCURRENCY).toBe(
      DELIVERY_CONCURRENCY,
    );
    expect(QUEUE_CONCURRENCY_DEFAULTS.NOTIFICATION_EXTERNAL_CONCURRENCY).toBe(
      DELIVERY_CONCURRENCY,
    );
    expect(QUEUE_CONCURRENCY_DEFAULTS.WEBHOOK_CONCURRENCY).toBe(
      WEBHOOK_CONCURRENCY,
    );
    expect(QUEUE_CONCURRENCY_DEFAULTS.WEBHOOK_PER_ENDPOINT_CONCURRENCY).toBe(
      WEBHOOK_PER_ENDPOINT_CONCURRENCY,
    );
  });

  it("treats an empty value as absent", () => {
    const parsed = parse(
      Object.fromEntries(QUEUE_CONCURRENCY_VARIABLES.map((name) => [name, ""])),
    );

    if (!parsed.success) throw parsed.error;

    const data = parsed.data as unknown as Parsed;

    for (const name of QUEUE_CONCURRENCY_VARIABLES) {
      expect(data[name]).toBe(QUEUE_CONCURRENCY_DEFAULTS[name]);
    }
  });
});

describe("a value out of range", () => {
  it.each(["0", "33", "2.5", "-1", "cinco"])(
    "fails the boot on %s, naming the variable",
    (value) => {
      for (const name of QUEUE_CONCURRENCY_VARIABLES) {
        expect(issuePaths({ [name]: value })).toContain(name);
      }
    },
  );

  it("takes up to 32 of each", () => {
    const parsed = parse(
      Object.fromEntries(
        QUEUE_CONCURRENCY_VARIABLES.map((name) => [name, "32"]),
      ),
    );

    if (!parsed.success) throw parsed.error;

    const data = parsed.data as unknown as Parsed;

    for (const name of QUEUE_CONCURRENCY_VARIABLES) {
      expect(data[name]).toBe(32);
    }
  });

  it("lets AI_LOCAL_MAX_CONCURRENCY follow the AI's instances up to 32", () => {
    expect(issuePaths({ AI_LOCAL_MAX_CONCURRENCY: "32" })).not.toContain(
      "AI_LOCAL_MAX_CONCURRENCY",
    );
    expect(issuePaths({ AI_LOCAL_MAX_CONCURRENCY: "33" })).toContain(
      "AI_LOCAL_MAX_CONCURRENCY",
    );
  });
});

describe("the lease invariants, with the environment's values", () => {
  it(
    "stop the boot when a lane's batch no longer fits its lease",
    async () => {
      // 20 deliveries one at a time, 15 s each: 300 s against a 180 s lease.
      await expect(
        loadUnder("@/shared/notifications/notification-pipeline-service", {
          NOTIFICATION_EXTERNAL_CONCURRENCY: 1,
        }),
      ).rejects.toThrow(/NOTIFICATION_EXTERNAL_CONCURRENCY=1/);

      await expect(
        loadUnder("@/shared/notifications/notification-pipeline-service", {
          NOTIFICATION_INTERNAL_CONCURRENCY: 1,
        }),
      ).rejects.toThrow(/NOTIFICATION_INTERNAL_CONCURRENCY=1/);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "stop the boot when the webhooks' batch no longer fits its lease",
    async () => {
      // 20 calls one at a time, 10 s each: 200 s against a 120 s lease.
      await expect(
        loadUnder("@/shared/integration/webhook-dispatch-service", {
          WEBHOOK_CONCURRENCY: 1,
        }),
      ).rejects.toThrow(/WEBHOOK_CONCURRENCY=1/);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "let the pipelines load with the smallest values that fit",
    async () => {
      await expect(
        loadUnder("@/shared/notifications/notification-pipeline-service", {
          NOTIFICATION_INTERNAL_CONCURRENCY: 2,
          NOTIFICATION_EXTERNAL_CONCURRENCY: 2,
        }),
      ).resolves.toBeDefined();

      await expect(
        loadUnder("@/shared/integration/webhook-dispatch-service", {
          WEBHOOK_CONCURRENCY: 2,
        }),
      ).resolves.toBeDefined();
    },
    LOAD_TIMEOUT_MS,
  );
});

type PipelineModule =
  typeof import("@/shared/notifications/notification-pipeline-service");
type WebhookModule =
  typeof import("@/shared/integration/webhook-dispatch-service");
type AIModule = typeof import("@/shared/ai/ai-analysis-pipeline-service");

describe("the pipelines run that many at a time", () => {
  it(
    "expands outbox events one after the other by default, and N with the variable",
    async () => {
      for (const [overrides, expected] of [
        [{}, 1],
        [{ OUTBOX_EXPANSION_CONCURRENCY: 3 }, 3],
      ] as const) {
        const { NotificationPipelineService } = await loadUnder<PipelineModule>(
          "@/shared/notifications/notification-pipeline-service",
          overrides,
        );

        const pipeline =
          NotificationPipelineService.getInstance() as unknown as {
            claimEvents: () => Promise<unknown[]>;
            renewEventLease: () => Promise<boolean>;
            expandEvent: () => Promise<void>;
            drainOutbox: () => Promise<boolean>;
          };

        const events = Array.from({ length: 7 }, (_, index) => ({
          id: `event-${index}`,
          topic: "test.topic",
          attempts: 1,
        }));
        const tracker = peakTracker();

        pipeline.claimEvents = vi
          .fn()
          .mockResolvedValueOnce(events)
          .mockResolvedValue([]);
        pipeline.renewEventLease = vi.fn().mockResolvedValue(true);
        pipeline.expandEvent = vi.fn(tracker.run);

        await pipeline.drainOutbox();

        expect(pipeline.expandEvent).toHaveBeenCalledTimes(7);
        expect(tracker.peak).toBe(expected);
      }
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "gives each delivery lane its own concurrency",
    async () => {
      const { NotificationPipelineService } = await loadUnder<PipelineModule>(
        "@/shared/notifications/notification-pipeline-service",
        { NOTIFICATION_INTERNAL_CONCURRENCY: 3 },
      );

      const pipeline = NotificationPipelineService.getInstance() as unknown as {
        claimDeliveries: () => Promise<unknown[]>;
        runOneDelivery: () => Promise<void>;
        drainDeliveries: (lane: string) => Promise<void>;
      };

      for (const [lane, expected] of [
        ["internal", 3],
        ["external", 5],
      ] as const) {
        const deliveries = Array.from({ length: 12 }, (_, index) => ({
          id: `delivery-${index}`,
          outboxEventId: "event-1",
          attempts: 1,
        }));
        const tracker = peakTracker();

        pipeline.claimDeliveries = vi
          .fn()
          .mockResolvedValueOnce(deliveries)
          .mockResolvedValue([]);
        pipeline.runOneDelivery = vi.fn(tracker.run);

        await pipeline.drainDeliveries(lane);

        expect(pipeline.runOneDelivery).toHaveBeenCalledTimes(12);
        expect(tracker.peak).toBe(expected);
      }
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "sends webhooks WEBHOOK_CONCURRENCY at a time",
    async () => {
      const { WebhookDispatchService } = await loadUnder<WebhookModule>(
        "@/shared/integration/webhook-dispatch-service",
        { WEBHOOK_CONCURRENCY: 3 },
      );

      const dispatcher = WebhookDispatchService.getInstance() as unknown as {
        claim: () => Promise<unknown[]>;
        deliver: () => Promise<void>;
        processBatch: () => Promise<number>;
      };

      // Six endpoints, two rows each: the per-endpoint limit of 2 is not
      // what holds the pool.
      const rows = Array.from({ length: 12 }, (_, index) => ({
        id: `webhook-${index}`,
        endpointId: `endpoint-${index % 6}`,
      }));
      const tracker = peakTracker();

      dispatcher.claim = vi
        .fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValue([]);
      dispatcher.deliver = vi.fn(tracker.run);

      await expect(dispatcher.processBatch()).resolves.toBe(12);

      expect(tracker.peak).toBe(3);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "sends WEBHOOK_PER_ENDPOINT_CONCURRENCY calls to one endpoint at a time (F3-07)",
    async () => {
      for (const [overrides, expected] of [
        [{}, 2],
        [{ WEBHOOK_PER_ENDPOINT_CONCURRENCY: 1 }, 1],
        [{ WEBHOOK_PER_ENDPOINT_CONCURRENCY: 4 }, 4],
      ] as const) {
        const { WebhookDispatchService } = await loadUnder<WebhookModule>(
          "@/shared/integration/webhook-dispatch-service",
          overrides,
        );

        const dispatcher = WebhookDispatchService.getInstance() as unknown as {
          claim: () => Promise<unknown[]>;
          deliver: () => Promise<void>;
          processBatch: () => Promise<number>;
        };

        // Ten rows of one endpoint: the per-endpoint cap is what holds the
        // pool, not WEBHOOK_CONCURRENCY (5).
        const rows = Array.from({ length: 10 }, (_, index) => ({
          id: `webhook-${index}`,
          endpointId: "endpoint-1",
        }));
        const tracker = peakTracker();

        dispatcher.claim = vi
          .fn()
          .mockResolvedValueOnce(rows)
          .mockResolvedValue([]);
        dispatcher.deliver = vi.fn(tracker.run);

        await expect(dispatcher.processBatch()).resolves.toBe(10);

        expect(tracker.peak).toBe(expected);
      }
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "keeps AI_CONCURRENCY readings in flight, lowered by the reader",
    async () => {
      const { AI_CONCURRENCY } = await loadUnder<AIModule>(
        "@/shared/ai/ai-analysis-pipeline-service",
        { AI_CONCURRENCY: 12 },
      );

      expect(AI_CONCURRENCY).toBe(12);
    },
    LOAD_TIMEOUT_MS,
  );
});

describe("the pool headroom at boot", () => {
  const defaults = { ...QUEUE_CONCURRENCY_DEFAULTS };
  const every = ["outbox", "internal", "external", "webhooks", "ai", "jobs"];

  it("stays quiet with the defaults, on today's pool and on the worker's", () => {
    // 1 outbox + 5 internal against 10 (the API of today) and 8 (the worker).
    for (const poolLimit of [10, 8, null]) {
      expect(
        poolHeadroomWarning({
          concurrency: defaults,
          workersEnabled: true,
          queues: every,
          poolLimit,
        }),
      ).toBeNull();
    }
  });

  it("warns, naming both queues, when the database-only slots take the pool", () => {
    const warning = poolHeadroomWarning({
      concurrency: {
        ...defaults,
        OUTBOX_EXPANSION_CONCURRENCY: 4,
        NOTIFICATION_INTERNAL_CONCURRENCY: 6,
      },
      workersEnabled: true,
      queues: every,
      poolLimit: 10,
    });

    expect(warning).toContain("outbox 4 + internal 6");
    expect(warning).toContain("somam 10 conexões, e o pool tem 10");
  });

  it("counts only what this process claims, and nothing without workers", () => {
    const heavy = {
      ...defaults,
      OUTBOX_EXPANSION_CONCURRENCY: 32,
      NOTIFICATION_INTERNAL_CONCURRENCY: 32,
      NOTIFICATION_EXTERNAL_CONCURRENCY: 32,
      WEBHOOK_CONCURRENCY: 32,
    };

    // A worker-external waits on the providers, not on the pool.
    expect(
      poolHeadroomWarning({
        concurrency: heavy,
        workersEnabled: true,
        queues: ["external", "webhooks"],
        poolLimit: 4,
      }),
    ).toBeNull();

    expect(
      poolHeadroomWarning({
        concurrency: heavy,
        workersEnabled: false,
        queues: every,
        poolLimit: 4,
      }),
    ).toBeNull();
  });

  it("reads a URL without connection_limit as pg's pool of 10", () => {
    expect(
      poolHeadroomWarning({
        concurrency: { ...defaults, NOTIFICATION_INTERNAL_CONCURRENCY: 9 },
        workersEnabled: true,
        queues: every,
        poolLimit: null,
      }),
    ).toContain("o pool tem 10");
  });
});
