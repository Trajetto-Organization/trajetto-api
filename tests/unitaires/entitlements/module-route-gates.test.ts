import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { MODULE_PERMISSION_KEYS } from "@/shared/entitlements/entitlement-service";

import {
  introspectRoutes,
  type IntrospectedRoute,
  type OpenApiOperation,
} from "../contract/support/introspect-routes";

/**
 * Switching a module off hides its endpoints (plan M9, S18): every route of
 * the module answers 403 MODULE_NOT_ENABLED to a company without it.
 *
 * The switch is enforced route by route — `verifyModuleEnabled` on each one,
 * or `requireModuleForPlugin` on a plugin — so a route that forgot it keeps
 * serving a module the company no longer pays for, and nothing at runtime
 * says so. Two sources must agree, and this file holds them together:
 *
 *   * MODULE_PERMISSION_KEYS — the permission keys each module gates, which
 *     the "Desligar módulo" dialog counts users by;
 *   * the gate each route publishes (`x-module`, read from the hook itself).
 *
 * A route that asks for a module's permission key and is not gated by that
 * module fails here, as does a fleet resource path without the FLEET gate.
 *
 * A unit test: building the document needs the router, not a database.
 */
let published: Array<IntrospectedRoute & { operation: OpenApiOperation }> = [];
let close: () => Promise<void>;

/** The fleet's own resources: every authenticated route under them is FLEET. */
const FLEET_PREFIXES = [
  "/fuel/",
  "/vehicle-checklist/",
  "/service-order/",
  "/service-order-part/",
  "/account-payable/",
  "/fines/",
  "/part/",
  "/supplier/",
];

type Grant = { key: string; access: string };

function keysOf(operation: OpenApiOperation): string[] {
  const all = (operation["x-permissions"] as Grant[] | undefined) ?? [];
  const any = (operation["x-permissions-any"] as Grant[][] | undefined) ?? [];

  return [...all, ...any.flat()].map((grant) => grant.key);
}

beforeAll(async () => {
  const introspected = await introspectRoutes();

  close = introspected.close;
  published = introspected.routes.filter(
    (route): route is IntrospectedRoute & { operation: OpenApiOperation } =>
      !route.hidden &&
      route.operation !== undefined &&
      route.onRequest.includes(ensureAuthenticated),
  );

  // An empty document would make every check below pass vacuously.
  expect(published.length).toBeGreaterThan(150);
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("the module switch, route by route (M9)", () => {
  it("gates every route that asks for a module's permission with that module", () => {
    const ungated: string[] = [];
    const checked: Record<string, number> = { FLEET: 0, DELIVERIES: 0 };

    for (const route of published) {
      const keys = keysOf(route.operation);

      for (const [module, moduleKeys] of Object.entries(
        MODULE_PERMISSION_KEYS,
      )) {
        // A route that accepts EITHER a module key or a shared one (the
        // pickers) is not the module's alone; only routes whose every
        // alternative is the module's must carry its gate.
        const asked = keys.filter((key) => moduleKeys.includes(key));

        if (asked.length === 0 || asked.length !== keys.length) continue;

        checked[module] += 1;

        if (route.operation["x-module"] !== module) {
          ungated.push(`${route.id} (${module})`);
        }
      }
    }

    expect(ungated).toEqual([]);

    // Not vacuous: both modules' routes were actually looked at.
    expect(checked.FLEET).toBeGreaterThan(30);
    expect(checked.DELIVERIES).toBeGreaterThan(20);
  });

  it("gates every authenticated route of a fleet resource with FLEET", () => {
    const fleetRoutes = published.filter((route) =>
      FLEET_PREFIXES.some((prefix) => route.openapiPath.startsWith(prefix)),
    );

    // The whole fleet, not a sample: a renamed prefix would empty this list.
    expect(fleetRoutes.length).toBeGreaterThan(40);

    expect(
      fleetRoutes
        .filter((route) => route.operation["x-module"] !== "FLEET")
        .map((route) => route.id),
    ).toEqual([]);
  });

  it("gates the app's reads by id (wave 3) with FLEET, the Kanban card like its board", () => {
    // A company that switched FLEET off must not keep serving an order or a
    // bill to the app through the new reads; the Kanban has no module.
    const byId = new Map(published.map((route) => [route.id, route]));

    for (const id of [
      "GET /service-order/{serviceOrderId}",
      "GET /service-order/mine",
      "GET /account-payable/{accountPayableId}",
    ]) {
      expect(byId.get(id)?.operation["x-module"], id).toBe("FLEET");
    }

    expect(byId.has("GET /kanban/card/{cardId}")).toBe(true);
    expect(
      byId.get("GET /kanban/card/{cardId}")?.operation["x-module"],
    ).toBeUndefined();
  });

  it("says MODULE_NOT_ENABLED on every gated route's 403", () => {
    const gated = published.filter(
      (route) => route.operation["x-module"] !== undefined,
    );

    expect(
      gated
        .filter(
          (route) =>
            !JSON.stringify(route.operation.responses["403"] ?? {}).includes(
              "MODULE_NOT_ENABLED",
            ),
        )
        .map((route) => route.id),
    ).toEqual([]);
  });
});
