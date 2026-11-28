import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SHED_CLASSES,
  SHED_CLASS_EXCEPTIONS,
  shedClassOf,
  shouldShed,
  type PressureReading,
  type ShedClass,
} from "@/shared/http/shed-classes";

/**
 * Which routes a pressed replica may refuse (plano-escala F2-24).
 *
 * A wrong class turns real work away: a driver's proof refused at the
 * customer's door, a refresh refused at the wrong second that logs the
 * driver out mid-route. So every route Fastify registers is read here, the
 * way it is served, and the two lists that matter are pinned by hand: what
 * is never refused (critical) and what is refused first (deferrable). A new
 * route lands in one of them only by a decision written below. No database:
 * `app.ready()` only builds the router.
 */
const registered: Array<{
  method: string;
  url: string;
  shedClass: ShedClass | undefined;
}> = [];
let close: () => Promise<unknown> = async () => undefined;

beforeAll(async () => {
  const { app } = await import("@/http");

  // Before ready(): the route plugins are deferred to the boot phase, so
  // this hook sees every route after http.ts set its class.
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) {
      registered.push({
        method: String(method).toUpperCase(),
        url: route.url,
        shedClass: (route.config as { shedClass?: ShedClass } | undefined)
          ?.shedClass,
      });
    }
  });

  await app.ready();
  close = () => app.close();
}, 120_000);

afterAll(async () => {
  await close();
});

const routesOf = (shedClass: ShedClass) =>
  [
    ...new Set(
      registered
        .filter((route) => route.shedClass === shedClass)
        .filter((route) => route.method !== "HEAD")
        .map(({ method, url }) => `${method} ${url}`),
    ),
  ].sort();

/** Never refused, whatever the pressure. */
const CRITICAL = [
  "GET /health",
  "GET /health/dead-letter",
  "GET /health/dead-letter/events",
  "GET /health/liveness",
  "GET /health/metrics",
  "GET /health/providers",
  "GET /health/readiness",
  "GET /health/rollout",
  "GET /integration/v1/catalogue",
  "POST /delivery/arrival/:deliveryId/business/:businessId",
  "POST /delivery/proof/:deliveryId/business/:businessId",
  "POST /delivery/report-occurrence/:deliveryId/business/:businessId",
  "POST /delivery/start-route/:businessId",
  "POST /driver-pause/end/:businessId",
  "POST /driver-pause/start/:businessId",
  "POST /fuel/create-fuel/:businessId",
  "POST /health/dead-letter/events/replay",
  "POST /health/dead-letter/replay",
  "POST /route/on-the-way/:stopId/route/:routeId/business/:businessId",
  "POST /route/start-route/:routeId/business/:businessId",
  "POST /uploads/presign/:businessId",
  "POST /user/logout",
  "POST /user/refresh-token",
  "POST /user/session/revoke",
  "POST /vehicle-checklist/create-vehicle-checklist/:businessId",
  "PUT /uploads/local",
];

/** Refused at the first threshold. */
const DEFERRABLE = [
  "GET /account-payable/export-account-payable",
  "GET /dashboard/overview",
  "GET /dashboard/trends",
  "GET /delivery/export-delivery",
  "GET /delivery/export-occurrence",
  "GET /delivery/operation-summary",
  "GET /driver/export-driver",
  "GET /fines/export-fine",
  "GET /fuel/export-fuel",
  "GET /route/control-tower",
  "GET /route/driver-trail/:driverId",
  "GET /route/live",
  "GET /route/monitoring",
  "GET /route/monitoring/drivers",
  "GET /service-order/export-service-order",
  "GET /vehicle-checklist/export-vehicle-checklist",
  "GET /vehicle/export-vehicle",
  "POST /route/positions",
];

describe("the shed classes", () => {
  it("give every route Fastify registers a class", () => {
    expect(registered.length).toBeGreaterThan(300);

    const missing = registered
      .filter(({ shedClass }) => !SHED_CLASSES.includes(shedClass!))
      .map(({ method, url }) => `${method} ${url}`);

    expect(missing).toEqual([]);
  });

  it("never refuse the driver's submissions, the session's end and refresh, nor the probes", () => {
    expect(routesOf("critical")).toEqual([...CRITICAL].sort());
  });

  it("refuse first only the positions, the tower and the exports", () => {
    expect(routesOf("deferrable")).toEqual([...DEFERRABLE].sort());
  });

  it("name in their exceptions only routes that exist", () => {
    const served = new Set(
      registered.map(({ method, url }) => `${method} ${url}`),
    );

    expect(
      Object.keys(SHED_CLASS_EXCEPTIONS).filter((route) => !served.has(route)),
    ).toEqual([]);
  });

  it("answer HEAD as its GET, ignore a trailing slash, and treat a 404 as interactive", () => {
    expect(shedClassOf("HEAD", "/health/liveness")).toBe("critical");
    expect(shedClassOf("GET", "/route/control-tower/")).toBe("deferrable");
    expect(shedClassOf("GET", undefined)).toBe("interactive");
    expect(shedClassOf("OPTIONS", "/route/control-tower")).toBe("interactive");
    expect(shedClassOf("GET", "/no/such/route")).toBe("interactive");
  });
});

describe("the decision", () => {
  const calm: PressureReading = { elu: 0.5, lagMs: 20, poolSaturated: false };

  it.each<[string, PressureReading, Record<ShedClass, boolean>]>([
    ["calm", calm, { critical: false, interactive: false, deferrable: false }],
    [
      "ELU just over 0.95",
      { ...calm, elu: 0.951 },
      { critical: false, interactive: false, deferrable: true },
    ],
    [
      "ELU exactly 0.95",
      { ...calm, elu: 0.95 },
      { critical: false, interactive: false, deferrable: false },
    ],
    [
      "lag over 300 ms",
      { ...calm, lagMs: 301 },
      { critical: false, interactive: false, deferrable: true },
    ],
    [
      "the pool's queue longer than the pool",
      { ...calm, poolSaturated: true },
      { critical: false, interactive: false, deferrable: true },
    ],
    [
      "ELU over 0.98",
      { ...calm, elu: 0.981 },
      { critical: false, interactive: true, deferrable: true },
    ],
    [
      "lag over a second",
      { ...calm, lagMs: 1_001 },
      { critical: false, interactive: true, deferrable: true },
    ],
    [
      "everything at once",
      { elu: 1, lagMs: 5_000, poolSaturated: true },
      { critical: false, interactive: true, deferrable: true },
    ],
  ])("under %s", (_label, reading, expected) => {
    for (const shedClass of SHED_CLASSES) {
      expect(shouldShed(shedClass, reading), shedClass).toBe(
        expected[shedClass],
      );
    }
  });
});
