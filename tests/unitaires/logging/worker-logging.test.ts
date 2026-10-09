import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

/**
 * One format, one level (OBS-14).
 *
 * Fastify wrote JSON; the workers, the socket layer and the cron scheduler
 * wrote `console.*` free text into the same stdout — two formats in one
 * stream, neither filterable by tenant, event or job. On top of that every
 * socket connect and disconnect was an unconditional line (at fleet scale,
 * most of the volume), the kanban dumped whole card payloads, and the level
 * was fixed at info.
 *
 * These files now write through the shared pino logger, and LOG_LEVEL sets
 * what reaches stdout.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "LOG_LEVEL" ? "warn" : target[key as keyof typeof target],
    }),
  };
});

const STRUCTURED = [
  "src/websocket.ts",
  "src/shared/services/kanban-service.ts",
  "src/shared/services/cron-scheduler-service.ts",
  "src/shared/services/redis-connection-log.ts",
  "src/shared/notifications/notification-pipeline-service.ts",
  "src/shared/notifications/outbox-service.ts",
  "src/workers/index.ts",
  "src/jobs/cron/cleanup-ai-pipeline-job.ts",
  "src/jobs/cron/cleanup-expired-refresh-tokens-job.ts",
  "src/jobs/cron/cleanup-notification-pipeline-job.ts",
  "src/jobs/cron/cleanup-user-history-job.ts",
];

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("the long-running parts of the API", () => {
  it.each(STRUCTURED)("%s writes through the shared logger", (path) => {
    const calls = source(path).match(/console\.(log|info|warn|error|debug)\(/g);

    expect(calls ?? []).toEqual([]);
  });
});

describe("the socket layer", () => {
  it("keeps per-connection lines at debug", () => {
    const websocket = source("src/websocket.ts");

    for (const message of [
      "socket connected",
      "socket logout",
      "socket disconnected",
    ]) {
      expect(websocket).toMatch(
        new RegExp(`log\\.debug\\([^;]*"${message}"`, "s"),
      );
    }
  });
});

describe("the kanban", () => {
  it("never dumps a card's payload", () => {
    expect(source("src/shared/services/kanban-service.ts")).not.toMatch(
      /(?:log|console)\.\w+\([^;]*\bcardData\b/s,
    );
  });
});

describe("the GPS adjustment audit lines", () => {
  it.each([
    "src/modules/fine/usecases/create-fine/create-fine-usecase.ts",
    "src/modules/fuel/usecases/create-fuel/create-fuel-usecase.ts",
    "src/modules/service-order/usecases/create-service-order/create-service-order-usecase.ts",
  ])("%s writes a structured event, not free text", (path) => {
    const code = source(path);

    expect(code).not.toContain("[AUDIT]");
    expect(code).toContain('event: "audit.gps_adjusted"');
  });
});

describe("LOG_LEVEL", () => {
  it("decides what reaches the output", async () => {
    const { buildLogger } = await import("@/shared/logging/logger");

    let written = "";

    const log = buildLogger(
      new Writable({
        write(chunk, _encoding, done) {
          written += chunk.toString();
          done();
        },
      }),
    );

    log.info("below the level");
    log.warn("at the level");

    expect(written).not.toContain("below the level");
    expect(written).toContain("at the level");
  });
});
