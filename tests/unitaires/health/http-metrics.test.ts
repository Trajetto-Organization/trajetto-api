import { describe, expect, it } from "vitest";

import {
  HTTP_LATENCY_BUCKETS_MS,
  MAX_POSITIONS_CONTRACTS,
  createHttpMetrics,
  recordHttpResponse,
} from "@/shared/health/http-metrics";
import { ROUTE_GROUPS } from "@/shared/health/route-groups";

/**
 * The HTTP counters of a process (plano-escala F1-09): status classes, a
 * fixed latency histogram per route group, and which app contract sends the
 * GPS positions.
 *
 * Every number is bounded whatever the traffic: twelve groups, ten buckets,
 * at most sixteen contract values (then "other"), and a contract count that
 * only remembers ten minutes. The contract count is the adoption the
 * positions' load shedding will wait for (F2-25): "≥ 90% of this replica's
 * POSTs of the last 10 minutes from contract ≥ 8".
 */
function clock(start = Date.parse("2026-11-15T12:00:00.000Z")) {
  let now = start;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the HTTP counters", () => {
  it("count the status classes, with 429 and 503 also on their own", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    for (const status of [200, 201, 304, 400, 404, 429, 500, 503]) {
      metrics.record("lists", status, 10, false);
    }

    const window = metrics.snapshot();

    expect(window.requests).toBe(8);
    expect(window.classes).toEqual({
      "2xx": 2,
      "3xx": 1,
      "4xx": 3,
      "5xx": 2,
      "429": 1,
      "503": 1,
    });
    expect(window.groups.lists.classes).toEqual(window.classes);
  });

  it("put each latency in the first bucket that holds it, from 25 ms to 10 s and above", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    expect(HTTP_LATENCY_BUCKETS_MS).toEqual([
      25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
    ]);

    for (const ms of [3, 25, 26, 300, 10_000, 10_001, 60_000]) {
      metrics.record("tower", 200, ms, false);
    }

    const tower = metrics.snapshot().groups.tower;

    // ≤25, ≤50, ≤100, ≤250, ≤500, ≤1000, ≤2500, ≤5000, ≤10000, above.
    expect(tower.latency_ms.counts).toEqual([2, 1, 0, 0, 1, 0, 0, 0, 1, 2]);
    expect(tower.latency_ms.sum).toBe(
      3 + 25 + 26 + 300 + 10_000 + 10_001 + 60_000,
    );
  });

  it("never turn a bad duration into NaN", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    metrics.record("details", 200, Number.NaN, false);
    metrics.record("details", 200, -5, false);

    const details = metrics.snapshot().groups.details;

    expect(details.latency_ms.counts[0]).toBe(2);
    expect(details.latency_ms.sum).toBe(0);
  });

  it("show every group on the endpoint, and only the busy ones in the minute row", () => {
    const time = clock();
    const metrics = createHttpMetrics({ now: time.now });

    metrics.record("positions", 200, 12, false);
    time.advance(60_000);

    expect(Object.keys(metrics.snapshot().groups)).toEqual([...ROUTE_GROUPS]);

    const sample = metrics.rotate();

    expect(sample.window_seconds).toBe(60);
    expect(Object.keys(sample.groups)).toEqual(["positions"]);
    expect(sample).not.toHaveProperty("latency_buckets_ms");

    // A new window starts empty.
    expect(metrics.snapshot().requests).toBe(0);
    expect(metrics.rotate().groups).toEqual({});
  });

  it("count the requests outside /health since the start, through every window", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    metrics.record("lists", 200, 5, false);
    metrics.record("other", 200, 1, true);
    metrics.rotate();
    metrics.record("auth", 401, 5, false);

    expect(metrics.servedTotal()).toBe(2);
  });
});

describe("the positions contracts", () => {
  it("count each contract, and unknown without the header", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    metrics.recordPositionsContract(7);
    metrics.recordPositionsContract(7);
    metrics.recordPositionsContract(8);
    metrics.recordPositionsContract(undefined);

    expect(metrics.snapshot().positions_contracts).toEqual({
      window_minutes: 10,
      total: 4,
      by_contract: { "7": 2, "8": 1, unknown: 1 },
    });
  });

  it("keep at most sixteen values, then count the rest as other", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    for (let contract = 1; contract <= 20; contract += 1) {
      metrics.recordPositionsContract(contract);
    }

    const { by_contract, total } = metrics.snapshot().positions_contracts;

    expect(MAX_POSITIONS_CONTRACTS).toBe(16);
    expect(Object.keys(by_contract)).toHaveLength(17);
    expect(by_contract.other).toBe(4);
    expect(total).toBe(20);
  });

  it("forget what is older than ten minutes, by the minute", () => {
    const time = clock();
    const metrics = createHttpMetrics({ now: time.now });

    metrics.recordPositionsContract(6);
    time.advance(5 * 60_000);
    metrics.recordPositionsContract(8);
    time.advance(5 * 60_000);

    // The contract-6 POST is ten minutes old: out of the window.
    expect(metrics.snapshot().positions_contracts.by_contract).toEqual({
      "8": 1,
    });

    time.advance(5 * 60_000);
    expect(metrics.snapshot().positions_contracts).toMatchObject({
      total: 0,
      by_contract: {},
    });
  });

  it("make room again once an old value leaves the window", () => {
    const time = clock();
    const metrics = createHttpMetrics({ now: time.now });

    for (let contract = 1; contract <= 16; contract += 1) {
      metrics.recordPositionsContract(contract);
    }
    time.advance(10 * 60_000);
    metrics.recordPositionsContract(99);

    expect(metrics.snapshot().positions_contracts.by_contract).toEqual({
      "99": 1,
    });
  });

  it("survive the rotation of the minute row: the window slides on its own", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    metrics.recordPositionsContract(8);
    const sample = metrics.rotate();

    expect(sample.positions_contracts.by_contract).toEqual({ "8": 1 });
    expect(metrics.snapshot().positions_contracts.total).toBe(1);
  });
});

describe("recordHttpResponse", () => {
  function request(
    method: string,
    url: string | undefined,
    headers: Record<string, string> = {},
  ) {
    return { method, routeOptions: { url }, headers } as never;
  }

  const reply = (statusCode: number, elapsedTime = 12) =>
    ({ statusCode, elapsedTime }) as never;

  it("counts by the route's group, and the contract on the positions POST", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    recordHttpResponse(
      request("POST", "/route/positions", {
        "x-trajetto-client-version":
          "platform=android; version=1.4.0; contract=7",
      }),
      reply(200),
      metrics,
    );
    recordHttpResponse(
      request("POST", "/route/positions"),
      reply(426),
      metrics,
    );
    recordHttpResponse(
      request("GET", "/route/control-tower"),
      reply(200),
      metrics,
    );

    const window = metrics.snapshot();

    expect(window.groups.positions.requests).toBe(2);
    expect(window.groups.tower.requests).toBe(1);
    expect(window.positions_contracts.by_contract).toEqual({
      "7": 1,
      unknown: 1,
    });
  });

  it("counts a 404 and an unlisted route as other, and /health outside the served total", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    recordHttpResponse(request("GET", undefined), reply(404), metrics);
    recordHttpResponse(request("GET", "/not/listed"), reply(200), metrics);
    recordHttpResponse(request("GET", "/health/liveness"), reply(200), metrics);

    expect(metrics.snapshot().groups.other.requests).toBe(3);
    expect(metrics.servedTotal()).toBe(2);
  });

  it("never throws, whatever the request looks like", () => {
    const metrics = createHttpMetrics({ now: clock().now });

    expect(() =>
      recordHttpResponse({} as never, {} as never, metrics),
    ).not.toThrow();
  });
});
