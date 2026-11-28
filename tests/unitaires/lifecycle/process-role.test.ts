import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  WORKER_QUEUE_NAMES,
  consumesQueue,
  parseWorkerQueues,
} from "@/shared/lifecycle/process-role";

/**
 * PROCESS_ROLE, a preset and a label (plano-escala F3-01, decision D15).
 *
 * One image runs as several Applications, the way ADR 0004 named: the API,
 * a worker, a scheduler, a realtime... Each needs a handful of variables
 * to agree — workers on or off, the cron, the queues, the sweeps, the
 * routes it answers — and a dedicated worker whose Environment forgot the
 * 2 s sweep polled every 30 s, so every notification the API published
 * waited for it.
 * The role is the preset that remembers; every variable given explicitly
 * still wins, and the boot names the ones that overrode the preset.
 *
 * What this pins, through the schema every process parses:
 *  - without any new variable, the process is exactly today's;
 *  - each role's preset, row by row;
 *  - an explicit variable beats the preset, and is listed as an override;
 *  - WORKERS_ENABLED stays the master switch;
 *  - a queue or role name nobody knows fails the boot.
 */

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

interface Resolved {
  PROCESS_ROLE: string;
  WORKERS_ENABLED: boolean;
  CRON_ENABLED: boolean;
  WORKER_QUEUES: readonly string[];
  SOCKETS_ENABLED: boolean;
  PIPELINE_SWEEP_INTERVAL_MS: number;
  WEBHOOK_SWEEP_INTERVAL_MS: number;
  HTTP_SURFACE: string;
  PROCESS_ROLE_OVERRIDES: readonly string[];
}

function parse(overrides: Record<string, string> = {}): Resolved {
  const parsed = envSchema.safeParse({ ...BASE_ENV, ...overrides });

  if (!parsed.success) throw parsed.error;

  return parsed.data as unknown as Resolved;
}

function refused(overrides: Record<string, string>): string {
  const parsed = envSchema.safeParse({ ...BASE_ENV, ...overrides });

  expect(parsed.success).toBe(false);

  return parsed.success ? "" : JSON.stringify(parsed.error.issues);
}

const ALL_QUEUES = [...WORKER_QUEUE_NAMES];

describe("without PROCESS_ROLE", () => {
  it("runs exactly what every replica ran before wave 12", () => {
    expect(parse()).toMatchObject({
      PROCESS_ROLE: "all",
      WORKERS_ENABLED: true,
      CRON_ENABLED: true,
      WORKER_QUEUES: ALL_QUEUES,
      SOCKETS_ENABLED: true,
      PIPELINE_SWEEP_INTERVAL_MS: 30_000,
      WEBHOOK_SWEEP_INTERVAL_MS: 5_000,
      HTTP_SURFACE: "all",
      PROCESS_ROLE_OVERRIDES: [],
    });
  });

  it("reads a legacy WORKERS_ENABLED=false as the api role, setting for setting", () => {
    const legacy = parse({ WORKERS_ENABLED: "false" });
    const api = parse({ PROCESS_ROLE: "api" });

    expect(legacy.PROCESS_ROLE).toBe("api");

    for (const key of [
      "WORKERS_ENABLED",
      "CRON_ENABLED",
      "WORKER_QUEUES",
      "HTTP_SURFACE",
    ] as const) {
      expect(legacy[key], key).toEqual(api[key]);
    }
  });

  it("treats every empty variable as absent", () => {
    expect(
      parse({
        PROCESS_ROLE: "",
        WORKERS_ENABLED: "",
        CRON_ENABLED: "",
        WORKER_QUEUES: "",
        SOCKETS_ENABLED: "",
        PIPELINE_SWEEP_INTERVAL_MS: "",
        WEBHOOK_SWEEP_INTERVAL_MS: "",
      }),
    ).toMatchObject(parse());
  });
});

describe("each role's preset", () => {
  it.each([
    // role, workers, cron, queues, sockets, pipeline sweep, webhook sweep,
    // surface
    ["all", true, true, ALL_QUEUES, true, 30_000, 5_000, "all"],
    ["api", false, false, [], true, 30_000, 5_000, "all"],
    ["worker", true, true, ALL_QUEUES, false, 2_000, 2_000, "health"],
    ["scheduler", true, true, [], false, 30_000, 5_000, "health"],
    ["realtime", false, false, [], true, 30_000, 5_000, "realtime"],
    [
      "worker-external",
      true,
      false,
      ["external"],
      false,
      2_000,
      5_000,
      "health",
    ],
    ["ingest", false, false, [], false, 30_000, 5_000, "ingest"],
  ] as const)(
    "%s",
    (
      role,
      workers,
      cron,
      queues,
      sockets,
      pipelineSweep,
      webhookSweep,
      surface,
    ) => {
      expect(parse({ PROCESS_ROLE: role })).toMatchObject({
        PROCESS_ROLE: role,
        WORKERS_ENABLED: workers,
        CRON_ENABLED: cron,
        WORKER_QUEUES: queues,
        SOCKETS_ENABLED: sockets,
        PIPELINE_SWEEP_INTERVAL_MS: pipelineSweep,
        WEBHOOK_SWEEP_INTERVAL_MS: webhookSweep,
        HTTP_SURFACE: surface,
        PROCESS_ROLE_OVERRIDES: [],
      });
    },
  );

  it("gives the worker the six queues and the cron, and the api neither", () => {
    const worker = parse({ PROCESS_ROLE: "worker" });
    const api = parse({ PROCESS_ROLE: "api" });

    expect(worker.WORKER_QUEUES).toHaveLength(6);
    expect(worker.CRON_ENABLED).toBe(true);

    expect(api.WORKER_QUEUES).toEqual([]);
    expect(api.CRON_ENABLED).toBe(false);
  });
});

describe("an explicit variable", () => {
  it("wins over the preset, and is named as an override", () => {
    const worker = parse({
      PROCESS_ROLE: "worker",
      CRON_ENABLED: "false",
      WORKER_QUEUES: "outbox,internal,webhooks,ai,jobs",
      PIPELINE_SWEEP_INTERVAL_MS: "1000",
    });

    expect(worker).toMatchObject({
      CRON_ENABLED: false,
      WORKER_QUEUES: ["outbox", "internal", "webhooks", "ai", "jobs"],
      PIPELINE_SWEEP_INTERVAL_MS: 1_000,
      WEBHOOK_SWEEP_INTERVAL_MS: 2_000,
    });
    expect(worker.PROCESS_ROLE_OVERRIDES).toEqual([
      "CRON_ENABLED",
      "WORKER_QUEUES",
      "PIPELINE_SWEEP_INTERVAL_MS",
    ]);
  });

  it("names SOCKETS_ENABLED=false on the api once the realtime role exists", () => {
    const api = parse({ PROCESS_ROLE: "api", SOCKETS_ENABLED: "false" });

    expect(api.SOCKETS_ENABLED).toBe(false);
    expect(api.PROCESS_ROLE_OVERRIDES).toEqual(["SOCKETS_ENABLED"]);
  });

  it("names WORKERS_ENABLED=true copied into the api, which keeps its workers", () => {
    const api = parse({ PROCESS_ROLE: "api", WORKERS_ENABLED: "true" });

    expect(api.WORKERS_ENABLED).toBe(true);
    expect(api.PROCESS_ROLE_OVERRIDES).toEqual(["WORKERS_ENABLED"]);
  });

  it("is no override when it says what the preset says", () => {
    expect(
      parse({
        PROCESS_ROLE: "worker",
        WORKERS_ENABLED: "true",
        PIPELINE_SWEEP_INTERVAL_MS: "2000",
        WORKER_QUEUES: "jobs,ai,webhooks,external,internal,outbox",
      }).PROCESS_ROLE_OVERRIDES,
    ).toEqual([]);
  });

  it("overrides nothing without PROCESS_ROLE: the variables are the configuration", () => {
    expect(
      parse({ PIPELINE_SWEEP_INTERVAL_MS: "2000", CRON_ENABLED: "false" })
        .PROCESS_ROLE_OVERRIDES,
    ).toEqual([]);
  });
});

describe("WORKERS_ENABLED=false", () => {
  it("is still the master switch: no queue and no cron, whatever else says", () => {
    const resolved = parse({
      PROCESS_ROLE: "worker",
      WORKERS_ENABLED: "false",
      CRON_ENABLED: "true",
      WORKER_QUEUES: "outbox",
    });

    expect(resolved.CRON_ENABLED).toBe(false);
    expect(resolved.WORKER_QUEUES).toEqual([]);
    expect(consumesQueue(resolved as never, "outbox")).toBe(false);
  });
});

describe("WORKER_QUEUES", () => {
  it("takes `none` for no queue, which an empty value cannot say", () => {
    expect(parse({ WORKER_QUEUES: "none" }).WORKER_QUEUES).toEqual([]);
    expect(parse({ PROCESS_ROLE: "scheduler" }).WORKER_QUEUES).toEqual([]);
  });

  it("dedupes, trims and keeps the canonical order", () => {
    expect(
      parse({ WORKER_QUEUES: " ai , outbox,ai ,external" }).WORKER_QUEUES,
    ).toEqual(["outbox", "external", "ai"]);
  });

  it("fails the boot on a queue nobody knows", () => {
    expect(refused({ WORKER_QUEUES: "foo" })).toMatch(/fila desconhecida/);
    expect(refused({ WORKER_QUEUES: "outbox,webhook" })).toMatch(/webhook/);
  });

  it("fails the boot on `none` mixed with queues, or on commas alone", () => {
    expect(refused({ WORKER_QUEUES: "none,outbox" })).toMatch(/none/);
    expect(parseWorkerQueues(" , ")).toHaveProperty("error");
  });
});

describe("PROCESS_ROLE", () => {
  it("fails the boot on a role nobody knows, instead of running everything", () => {
    refused({ PROCESS_ROLE: "wroker" });
    refused({ PROCESS_ROLE: "WORKER" });
  });
});

describe("the sweeps", () => {
  it("keep their floors", () => {
    refused({ PIPELINE_SWEEP_INTERVAL_MS: "10" });
    refused({ WEBHOOK_SWEEP_INTERVAL_MS: "100" });
  });
});
