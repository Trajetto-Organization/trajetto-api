import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HttpWindowSnapshot } from "@/shared/health/http-metrics";

/**
 * The HTTP counters through the real stack (plano-escala F1-09): the
 * `onResponse` hook of src/http.ts sees every response — the 401 of the
 * authentication hook, the 404 with no route — files it under the route's
 * group, and on POST /route/positions counts the contract the app named.
 * That count is per replica and is what the positions' load shedding will
 * wait for (F2-25), so it must see the requests the gate refuses too.
 */
let app: Awaited<typeof import("@/http")>["app"];
let snapshot: () => HttpWindowSnapshot;

beforeAll(async () => {
  ({ app } = await import("@/http"));
  const { httpMetrics } = await import("@/shared/health/http-metrics");

  snapshot = () => httpMetrics.snapshot();

  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("the HTTP counters", () => {
  it("count each response under its route group, refusals included", async () => {
    const before = snapshot();

    const positions = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: {
        "x-trajetto-client-version":
          "platform=android; version=1.4.0; build=42; contract=7; outbox=1",
      },
      payload: { positions: [] },
    });
    await app.inject({
      method: "POST",
      url: "/route/positions",
      payload: { positions: [] },
    });
    await app.inject({ method: "GET", url: "/route/control-tower" });
    await app.inject({ method: "GET", url: "/nada-aqui" });

    expect(positions.statusCode).toBe(401);

    const after = snapshot();
    const delta = (group: keyof HttpWindowSnapshot["groups"]) =>
      after.groups[group].requests - before.groups[group].requests;

    expect(delta("positions")).toBe(2);
    expect(
      after.groups.positions.classes["4xx"] -
        before.groups.positions.classes["4xx"],
    ).toBe(2);
    expect(delta("tower")).toBe(1);
    expect(delta("other")).toBeGreaterThanOrEqual(1);
    expect(after.requests - before.requests).toBe(4);

    const contracts = after.positions_contracts.by_contract;
    const was = before.positions_contracts.by_contract;

    expect((contracts["7"] ?? 0) - (was["7"] ?? 0)).toBe(1);
    expect((contracts.unknown ?? 0) - (was.unknown ?? 0)).toBe(1);
  });

  it("put each latency in a bucket, every group present", () => {
    const window = snapshot();

    expect(Object.keys(window.groups)).toHaveLength(12);
    expect(window.groups.positions.latency_ms.counts).toHaveLength(10);
    expect(
      window.groups.positions.latency_ms.counts.reduce((a, b) => a + b, 0),
    ).toBe(window.groups.positions.requests);
  });
});
