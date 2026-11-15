import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RETIRED_ROUTES } from "@/routes/retired-routes";
import {
  ROUTE_GROUPS,
  ROUTE_GROUP_TABLE,
  routeGroupOf,
} from "@/shared/health/route-groups";

/**
 * Every route the API registers has a group chosen for it (plano-escala
 * F1-09).
 *
 * The HTTP counters and the latency histogram are per group, and the scale
 * decisions read them by group ("posições > 30% da CPU do HTTP", the panel
 * reads' p95). A route without a group would count as "other" with nobody
 * having decided it — a new heavy list hiding in the noise. So the routes
 * are read from Fastify itself, through onRoute, the way they are served:
 * every method, HEAD and OPTIONS included. No database: `app.ready()` only
 * builds the router.
 */
const registered: Array<{ method: string; url: string }> = [];
let close: () => Promise<unknown> = async () => undefined;

beforeAll(async () => {
  const { app } = await import("@/http");

  // Before ready(): every route plugin is deferred to the boot phase, so the
  // hook still sees all of them.
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) {
      registered.push({ method: String(method).toUpperCase(), url: route.url });
    }
  });

  await app.ready();
  close = () => app.close();
}, 120_000);

afterAll(async () => {
  await close();
});

describe("the route groups", () => {
  it("are twelve at most", () => {
    expect(ROUTE_GROUPS.length).toBeLessThanOrEqual(12);
    expect(Object.keys(ROUTE_GROUP_TABLE).sort()).toEqual(
      [...ROUTE_GROUPS].sort(),
    );
  });

  it("name a group for every route Fastify registers", () => {
    expect(registered.length).toBeGreaterThan(300);

    const missing = registered
      .filter(({ method, url }) => routeGroupOf(method, url) === undefined)
      .map(({ method, url }) => `${method} ${url}`);

    // Add each one to ROUTE_GROUP_TABLE (src/shared/health/route-groups.ts),
    // in the group its traffic belongs to.
    expect(missing).toEqual([]);
  });

  it("list each route once, and only routes that exist", () => {
    const listed = Object.values(ROUTE_GROUP_TABLE).flat();
    const served = new Set(
      registered.map(({ method, url }) => `${method} ${url}`),
    );

    expect(listed.length).toBe(new Set(listed).size);
    expect(listed.filter((route) => !served.has(route))).toEqual([]);
  });

  it("count the retired routes, a 404 and a CORS preflight as other", () => {
    for (const retired of RETIRED_ROUTES) {
      expect(routeGroupOf(retired.method, retired.url)).toBe("other");
    }

    expect(routeGroupOf("GET", undefined)).toBe("other");
    expect(routeGroupOf("OPTIONS", "/route/positions")).toBe("other");
  });

  it("count a HEAD as its GET, and a trailing slash as the pattern without it", () => {
    expect(routeGroupOf("HEAD", "/route/control-tower")).toBe("tower");
    expect(routeGroupOf("GET", "/docs/")).toBe("other");
  });

  it("put the GPS ingest alone in positions", () => {
    expect(ROUTE_GROUP_TABLE.positions).toEqual(["POST /route/positions"]);
    expect(routeGroupOf("POST", "/route/positions")).toBe("positions");
  });
});
