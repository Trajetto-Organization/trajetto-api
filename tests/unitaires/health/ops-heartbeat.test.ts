import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OBS-03: the push half of the alerting. Every minute, one replica (the cron
 * election) evaluates the operational rules and tells an external dead man's
 * switch (healthchecks.io, Uptime Kuma, BetterStack): a ping when all is
 * well, `/fail` with the reasons when not. A process that died, a database
 * that is gone, a scheduler that stopped — all of them simply stop pinging,
 * and the silence is what pages.
 */
const snapshot = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("@/shared/health/operational-snapshot", () => ({
  collectOperationalSnapshot: async () => snapshot.current,
}));

const envMock = vi.hoisted(() => ({
  LOG_LEVEL: "silent",
  HEALTHCHECK_PING_URL: undefined as string | undefined,
  HEALTHCHECK_FAIL_URL: undefined as string | undefined,
}));

vi.mock("@/env", () => ({ env: envMock }));

const NOW = new Date("2026-09-24T12:00:00Z");

function healthySnapshot() {
  return {
    now: NOW,
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
  };
}

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) => new Response("OK", { status: 200 }),
);

beforeEach(() => {
  envMock.HEALTHCHECK_PING_URL = undefined;
  envMock.HEALTHCHECK_FAIL_URL = undefined;
  snapshot.current = healthySnapshot();

  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runJob() {
  const { opsHeartbeatJob } = await import("@/jobs/cron/ops-heartbeat-job");

  await opsHeartbeatJob.handler();

  return opsHeartbeatJob;
}

describe("the ops heartbeat job", () => {
  it("runs every minute, through the cron election, quietly", async () => {
    const job = await runJob();

    expect(job.schedule).toBe("* * * * *");
    expect(job.quiet).toBe(true);
  });

  it("calls nothing while no check is configured", async () => {
    snapshot.current = { ...healthySnapshot(), outboxEligibleLagSec: 9_999 };

    await runJob();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pings the check when every rule passes", async () => {
    envMock.HEALTHCHECK_PING_URL = "https://hc-ping.com/abc-123";

    await runJob();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hc-ping.com/abc-123");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports /fail with the reasons when a rule breaks", async () => {
    envMock.HEALTHCHECK_PING_URL = "https://hc-ping.com/abc-123";
    snapshot.current = {
      ...healthySnapshot(),
      deliveryFailures: [
        { channel: "WHATSAPP", lastError: "[whatsapp http=401 code=190] Session has expired" },
      ],
    };

    await runJob();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hc-ping.com/abc-123/fail");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("code=190");
  });

  it("uses the explicit failure URL when one is set (Uptime Kuma)", async () => {
    envMock.HEALTHCHECK_PING_URL = "https://kuma.exemplo.com/api/push/tok?status=up&msg=OK";
    envMock.HEALTHCHECK_FAIL_URL = "https://kuma.exemplo.com/api/push/tok?status=down&msg=degraded";
    snapshot.current = { ...healthySnapshot(), redisOk: false };

    await runJob();

    // Kuma reads status and msg from the QUERY and ignores any body, and its
    // 1.23 line routes only GET on /api/push/:token — a POST there is a 404
    // and the check only noticed through the silence, reasons lost.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const called = new URL(url);

    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(`${called.origin}${called.pathname}`).toBe(
      "https://kuma.exemplo.com/api/push/tok",
    );
    expect(called.searchParams.get("status")).toBe("down");
    expect(called.searchParams.get("msg")).toMatch(/Redis/);
  });

  it("keeps Kuma's msg to a size a URL and a notification can carry", async () => {
    envMock.HEALTHCHECK_PING_URL = "https://kuma.exemplo.com/api/push/tok?status=up&msg=OK";
    envMock.HEALTHCHECK_FAIL_URL = "https://kuma.exemplo.com/api/push/tok?status=down";
    snapshot.current = {
      ...healthySnapshot(),
      collectionErrors: Array.from({ length: 40 }, (_, i) => `parte ${i}: ${"x".repeat(150)}`),
    };

    await runJob();

    const msg = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("msg") ?? "";

    expect(msg.length).toBeGreaterThan(0);
    expect(msg.length).toBeLessThanOrEqual(500);
  });

  it("never fails the run because the check itself is unreachable", async () => {
    envMock.HEALTHCHECK_PING_URL = "https://hc-ping.com/abc-123";
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(runJob()).resolves.toBeDefined();
  });
});

describe("the production compose", () => {
  it("passes the heartbeat URLs to the API, optional", () => {
    const compose = readFileSync(resolve(process.cwd(), "compose.production.yaml"), "utf8");

    expect(compose).toMatch(/HEALTHCHECK_PING_URL: \$\{HEALTHCHECK_PING_URL:-\}/);
    expect(compose).toMatch(/HEALTHCHECK_FAIL_URL: \$\{HEALTHCHECK_FAIL_URL:-\}/);
  });
});
