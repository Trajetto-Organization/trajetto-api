import { afterEach, describe, expect, it, vi } from "vitest";

import {
  READINESS_TIMEOUT_MS,
  probeDatabase,
  probeUrl,
} from "@/shared/health/readiness-probe";

/**
 * The readiness probe's own connection (OBS-11): one connection, short
 * timeouts, the production URL's other parameters kept — the statement and
 * lock timeouts travel in `options`, and a probe without them would be the
 * one client of the database with no ceiling.
 */
const PRODUCTION_URL =
  "postgresql://u:p@db:5432/trajetto?schema=public&connection_limit=10&pool_timeout=20" +
  "&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000";

afterEach(() => {
  vi.useRealTimers();
});

describe("probeUrl", () => {
  it("opens one connection with short timeouts and keeps everything else", () => {
    const url = new URL(probeUrl(PRODUCTION_URL));

    expect(url.searchParams.get("connection_limit")).toBe("1");
    expect(Number(url.searchParams.get("pool_timeout"))).toBeLessThanOrEqual(2);
    expect(Number(url.searchParams.get("connect_timeout"))).toBeLessThanOrEqual(3);
    expect(Number(url.searchParams.get("socket_timeout"))).toBeLessThanOrEqual(3);

    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("options")).toBe(
      "-c statement_timeout=30000 -c lock_timeout=5000",
    );
    expect(url.host).toBe("db:5432");
    expect(url.username).toBe("u");
  });
});

describe("probeDatabase", () => {
  it("says no, within its timeout, when the database never answers", async () => {
    vi.useFakeTimers();

    const hung = { $queryRaw: () => new Promise(() => {}) };

    let answer: boolean | undefined;
    void probeDatabase(READINESS_TIMEOUT_MS, hung).then((ready) => {
      answer = ready;
    });

    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 10);

    expect(answer).toBe(false);

    // Below Traefik's 5 s: the balancer gets an answer, not a timeout.
    expect(READINESS_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it("says no when the query fails", async () => {
    const down = {
      $queryRaw: () => Promise.reject(new Error("Can't reach database server")),
    };

    expect(await probeDatabase(READINESS_TIMEOUT_MS, down)).toBe(false);
  });

  it("says yes when it answers", async () => {
    const up = { $queryRaw: () => Promise.resolve([{ "?column?": 1 }]) };

    expect(await probeDatabase(READINESS_TIMEOUT_MS, up)).toBe(true);
  });
});
