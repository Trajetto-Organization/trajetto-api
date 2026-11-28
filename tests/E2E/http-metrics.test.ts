import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";
import type { HttpWindowSnapshot } from "@/shared/health/http-metrics";

/**
 * The HTTP counters through the real stack (plano-escala F1-09): the
 * `onResponse` hook of src/http.ts sees every response — the 401 of the
 * authentication hook, the 404 with no route — files it under the route's
 * group, and on POST /route/positions counts the contract the app named.
 *
 * That count is per replica and is what the positions' load shedding will
 * wait for (F2-25: "≥ 90% of the POSTs of the last 10 minutes from contract
 * ≥ 8"). The contract is a header anyone can set, so it counts only once a
 * driver's session got through: an anonymous loop of 401s naming
 * contract=99 must not read as a fleet that already moved on, and start
 * shedding the old builds still in half the trucks.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdcb0-0000-7000-8000-0000000f1090";

let app: Awaited<typeof import("@/http")>["app"];
let snapshot: () => HttpWindowSnapshot;

let driverToken = "";
let managerToken = "";

const clientVersion = (contract: number) =>
  `platform=android; version=1.4.0; build=42; contract=${contract}; outbox=1`;

// One valid point: with no route in progress the driver gets 200 with
// tracking false, so nothing here depends on a route.
const ping = () => ({
  latitude: -23.55,
  longitude: -46.63,
  accuracy: 10,
  speed: 30,
  heading: 90,
  battery: 80,
  recorded_at: new Date(Date.now() - 15_000).toISOString(),
});

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });

  driverToken = seed.driverToken;
  managerToken = seed.managerToken;

  ({ app } = await import("@/http"));
  const { httpMetrics } = await import("@/shared/health/http-metrics");

  snapshot = () => httpMetrics.snapshot();

  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const contractDelta = (
  before: HttpWindowSnapshot,
  after: HttpWindowSnapshot,
  key: string,
) =>
  (after.positions_contracts.by_contract[key] ?? 0) -
  (before.positions_contracts.by_contract[key] ?? 0);

describe("the HTTP counters", () => {
  it("count each response under its route group, refusals included", async () => {
    const before = snapshot();

    const positions = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: { "x-trajetto-client-version": clientVersion(7) },
      payload: { pings: [ping()] },
    });
    await app.inject({
      method: "POST",
      url: "/route/positions",
      payload: { pings: [ping()] },
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

describe("the positions contracts", () => {
  it("count a driver's session, with unknown when it names none", async () => {
    const before = snapshot();

    const named = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: {
        authorization: `Bearer ${driverToken}`,
        "x-trajetto-client-version": clientVersion(8),
      },
      payload: { pings: [ping()] },
    });
    const bare = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { pings: [ping()] },
    });

    expect(named.statusCode, named.body).toBe(200);
    expect(bare.statusCode, bare.body).toBe(200);

    const after = snapshot();

    expect(contractDelta(before, after, "8")).toBe(1);
    expect(contractDelta(before, after, "unknown")).toBe(1);
    expect(
      after.positions_contracts.total - before.positions_contracts.total,
    ).toBe(2);
  });

  it("leave out the anonymous refusal and the session that is not a driver's", async () => {
    const before = snapshot();

    const anonymous = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: { "x-trajetto-client-version": clientVersion(99) },
      payload: { pings: [ping()] },
    });
    const forgedToken = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: {
        authorization: "Bearer not-a-token",
        "x-trajetto-client-version": clientVersion(99),
      },
      payload: { pings: [ping()] },
    });
    const manager = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: {
        authorization: `Bearer ${managerToken}`,
        "x-trajetto-client-version": clientVersion(98),
      },
      payload: { pings: [ping()] },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(forgedToken.statusCode).toBe(401);
    expect(manager.statusCode, manager.body).toBe(403);

    const after = snapshot();

    // Counted as traffic, never as adoption.
    expect(
      after.groups.positions.requests - before.groups.positions.requests,
    ).toBe(3);
    expect(after.positions_contracts.total).toBe(
      before.positions_contracts.total,
    );
    expect(after.positions_contracts.by_contract).not.toHaveProperty("99");
    expect(after.positions_contracts.by_contract).not.toHaveProperty("98");
  });
});
