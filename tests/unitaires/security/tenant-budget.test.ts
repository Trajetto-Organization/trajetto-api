import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import {
  configureIntegrationRateGuard,
  unlimitedIntegrationRateGuard,
  type IntegrationRateGuard,
} from "@/shared/integration/integration-rate-guard";
import {
  chargePanelTenant,
  chargePanelUser,
  isPanelSession,
  panelBudgetMetrics,
  panelCostFor,
  panelCostOf,
} from "@/shared/integration/panel-budget";

/**
 * Each company's panel budget, with each person's slice (plano-escala
 * F2-28, decision D41).
 *
 * The rate limiter keeps a person to 300 requests a minute whatever they
 * cost, so one company's dispatch room with twenty towers and a few exports
 * open could spend the pool every other company waits on. The budget
 * weighs each request and caps the company; the person's slice (25%) is
 * charged BEFORE the session lookup, so a revoked token in a loop, or one
 * person alone, never empties the company's minute. Observe, the default,
 * refuses nothing; Redis failing lets everything through.
 */

const saved = {
  mode: env.TENANT_PANEL_BUDGET_MODE,
  perMinute: env.TENANT_PANEL_BUDGET_PER_MINUTE,
  share: env.TENANT_PANEL_USER_SHARE,
};

/** An in-memory minute: what the Lua script does, per key. */
function memoryGuard(): IntegrationRateGuard & { totals: Map<string, number> } {
  const totals = new Map<string, number>();

  return {
    ...unlimitedIntegrationRateGuard,
    totals,
    spendPanelBudget: vi.fn(async (key: string, cost: number) => {
      const total = (totals.get(key) ?? 0) + cost;

      totals.set(key, total);

      return { total, resetInMs: 42_500 };
    }),
  };
}

function request(
  url: string,
  {
    method = "GET",
    query = {},
    user,
  }: {
    method?: string;
    query?: Record<string, unknown>;
    user?: Record<string, unknown>;
  } = {},
) {
  return {
    method,
    query,
    routeOptions: { url, config: {} },
    user,
  } as never;
}

const PANEL = { sub: "user-1", role: "BUSINESS_USER", driverId: null };
const PANEL_USER = {
  id: "user-1",
  role: "BUSINESS_USER",
  businessId: "business-1",
  driverId: null,
};

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceBusyError);
    const busy = error as ServiceBusyError;

    return {
      status: busy.statusCode,
      code: busy.code,
      retryAfter: busy.retryAfterSeconds,
    };
  }
}

let guard: ReturnType<typeof memoryGuard>;

beforeEach(() => {
  guard = memoryGuard();
  configureIntegrationRateGuard(guard);
  panelBudgetMetrics.rotate();

  env.TENANT_PANEL_BUDGET_MODE = "enforce";
  env.TENANT_PANEL_BUDGET_PER_MINUTE = 40;
  env.TENANT_PANEL_USER_SHARE = 0.25;
});

afterEach(() => {
  configureIntegrationRateGuard(unlimitedIntegrationRateGuard);

  env.TENANT_PANEL_BUDGET_MODE = saved.mode;
  env.TENANT_PANEL_BUDGET_PER_MINUTE = saved.perMinute;
  env.TENANT_PANEL_USER_SHARE = saved.share;
});

describe("what a request costs", () => {
  it("weighs the tower, the lists and the exports above a detail", () => {
    expect(panelCostOf("GET", "/user/me")).toBe(1);
    expect(
      panelCostOf(
        "PATCH",
        "/vehicle/update-vehicle/:vehicleId/business/:businessId",
      ),
    ).toBe(1);
    expect(panelCostOf("GET", "/route/control-tower")).toBe(3);
    expect(panelCostOf("GET", "/driver/list-driver")).toBe(5);
    expect(panelCostOf("GET", "/delivery/export-delivery")).toBe(20);
  });

  it("doubles a listing of deliveries or routes asked for every date", () => {
    expect(panelCostFor(request("/delivery/list-delivery"))).toBe(10);
    expect(
      panelCostFor(
        request("/delivery/list-delivery", { query: { period: "7d" } }),
      ),
    ).toBe(5);
    expect(panelCostFor(request("/route/list-routes"))).toBe(10);
    expect(panelCostFor(request("/driver/list-driver"))).toBe(5);
  });

  it("takes the route's own cost when it declares one", () => {
    const declared = {
      method: "GET",
      query: {},
      routeOptions: { url: "/user/me", config: { panelCost: 7 } },
    } as never;

    expect(panelCostFor(declared)).toBe(7);
  });
});

describe("who pays", () => {
  it("is a panel session only: never a driver's, never the MASTER", () => {
    expect(isPanelSession({ role: "BUSINESS_ADMIN", driverId: null })).toBe(
      true,
    );
    expect(isPanelSession({ role: "BUSINESS_USER", driverId: null })).toBe(
      true,
    );
    expect(
      isPanelSession({ role: "BUSINESS_USER", driverId: "driver-1" }),
    ).toBe(false);
    expect(isPanelSession({ role: "MASTER", driverId: null })).toBe(false);
  });

  it("spends nothing for a driver or the MASTER", async () => {
    await chargePanelUser(request("/user/me"), {
      sub: "driver-user",
      role: "BUSINESS_USER",
      driverId: "driver-1",
    });
    await chargePanelUser(request("/user/me"), {
      sub: "master",
      role: "MASTER",
      driverId: null,
    });
    await chargePanelTenant(
      request("/user/me", {
        user: { ...PANEL_USER, driverId: "driver-1" },
      }),
    );

    expect(guard.spendPanelBudget).not.toHaveBeenCalled();
  });
});

describe("in enforce", () => {
  it("refuses a person past a quarter of the company, before the session", async () => {
    // The slice: 40 × 0.25 = 10 units.
    for (let index = 0; index < 10; index += 1) {
      expect(
        await refusalOf(() => chargePanelUser(request("/user/me"), PANEL)),
      ).toBeNull();
    }

    expect(
      await refusalOf(() => chargePanelUser(request("/user/me"), PANEL)),
    ).toEqual({ status: 429, code: "TENANT_BUSY", retryAfter: 43 });

    expect(guard.totals.get("panel-user:user-1")).toBe(11);
    expect(panelBudgetMetrics.snapshot().refused).toEqual({
      user: 1,
      tenant: 0,
    });
  });

  it("refuses the company past its budget, after the session", async () => {
    for (let index = 0; index < 4; index += 1) {
      const user = { ...PANEL_USER, id: `user-${index}` };

      for (let call = 0; call < 10; call += 1) {
        await chargePanelTenant(request("/user/me", { user }));
      }
    }

    expect(guard.totals.get("panel:business-1")).toBe(40);

    expect(
      await refusalOf(() =>
        chargePanelTenant(request("/user/me", { user: PANEL_USER })),
      ),
    ).toEqual({ status: 429, code: "TENANT_BUSY", retryAfter: 43 });
  });

  it("never lets one person spend more than their slice of the company", async () => {
    // One person in a loop, through both charges as ensureAuthenticated
    // runs them: refused at the slice, the company's budget stops there.
    for (let index = 0; index < 50; index += 1) {
      const outcome = await refusalOf(async () => {
        await chargePanelUser(request("/route/control-tower"), PANEL);
        await chargePanelTenant(
          request("/route/control-tower", { user: PANEL_USER }),
        );
      });

      if (outcome) expect(outcome.code).toBe("TENANT_BUSY");
    }

    const tenant = guard.totals.get("panel:business-1") ?? 0;

    expect(tenant).toBeLessThanOrEqual(40 * 0.25);
    expect(tenant).toBeGreaterThan(0);
  });
});

describe("in observe (the default)", () => {
  beforeEach(() => {
    env.TENANT_PANEL_BUDGET_MODE = "observe";
  });

  it("refuses nothing, counts what enforce would, and keeps one person's flood off the company", async () => {
    for (let index = 0; index < 30; index += 1) {
      const user = request("/user/me", { user: PANEL_USER });

      expect(await refusalOf(() => chargePanelUser(user, PANEL))).toBeNull();
      expect(await refusalOf(() => chargePanelTenant(user))).toBeNull();
    }

    expect(panelBudgetMetrics.snapshot()).toMatchObject({
      mode: "observe",
      would_refuse: { user: 20, tenant: 0 },
      refused: { user: 0, tenant: 0 },
    });

    // The twenty over the slice never reached the company's budget.
    expect(guard.totals.get("panel:business-1")).toBe(10);
  });
});

describe("failing open", () => {
  it("lets the request through, uncounted, when Redis does not answer", async () => {
    configureIntegrationRateGuard(unlimitedIntegrationRateGuard);

    expect(
      await refusalOf(() => chargePanelUser(request("/user/me"), PANEL)),
    ).toBeNull();
    expect(
      await refusalOf(() =>
        chargePanelTenant(request("/user/me", { user: PANEL_USER })),
      ),
    ).toBeNull();
    expect(panelBudgetMetrics.snapshot().unavailable).toBe(2);
  });

  it("spends nothing at all when switched off", async () => {
    env.TENANT_PANEL_BUDGET_MODE = "off";

    await chargePanelUser(request("/user/me"), PANEL);
    await chargePanelTenant(request("/user/me", { user: PANEL_USER }));

    expect(guard.spendPanelBudget).not.toHaveBeenCalled();
  });
});
