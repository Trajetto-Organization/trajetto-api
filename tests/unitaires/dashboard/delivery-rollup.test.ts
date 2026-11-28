import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entitlements = vi.hoisted(() => ({ getBusinessEntitlements: vi.fn() }));

vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);
vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

import type { Business } from "@/modules/business/dtos/business-dto";
import type { User } from "@/modules/user/dtos/user-dto";

import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";
import {
  dashboardRollupShadowIdle,
  deliveriesFromRollup,
  readWithRollup,
  sameBuckets,
  shadowDeliveryRollup,
} from "@/modules/dashboard/usecases/shared/delivery-rollup";
import { env } from "@/env";
import {
  enterRequestContext,
  getRequestContext,
} from "@/shared/http/request-context";
import {
  dashboardRollupMetrics,
  resetDashboardRollupMetrics,
} from "@/shared/rollup/dashboard-rollup-metrics";
import {
  businessDayWindow,
  businessMonthWindow,
} from "@/shared/time/business-day";

import { clearLogged, logged } from "../../support/log-capture";

/**
 * DASHBOARD_ROLLUP_MODE (plano-escala F4-22, decision D52) through the use
 * cases, on the in-memory twin: with "shadow" the screen serves what it
 * served before and the comparison runs on the side, one at a time, never
 * failing the view; a difference is called a divergence only when the
 * rollup and a live count of ONE snapshot disagree, and every divergence
 * is counted and logged (the owner's gate before "on" is seven days without
 * one); with "on" the "Entregas" arm reads the rollup, and a failure of that
 * read is served live instead of a 500; with "off" nothing changes at all.
 */
const COMPANY = "018f5310-0000-7000-8000-00000000000a";
const ADMIN = "018f5310-0000-7000-8000-0000000000a1";
const MASTER = "018f5310-0000-7000-8000-0000000000f1";

// 15:00 in São Paulo on 19/11/2026.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const SP = "America/Sao_Paulo";

const initialMode = env.DASHBOARD_ROLLUP_MODE;

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let dashboard: InMemoryDashboardRepository;

function overview() {
  return new GetDashboardOverviewUseCase(
    users,
    dashboard,
    new InMemoryActivityRepository(),
    new InMemoryDeliveryRepository(),
    businesses,
    new InMemoryOperationDayRepository(),
  );
}

function trends() {
  return new GetDashboardTrendsUseCase(users, dashboard, businesses);
}

const day = (key: string) => ({ period: key, count: 1 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  resetDashboardRollupMetrics();
  clearLogged();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  dashboard = new InMemoryDashboardRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: COMPANY } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push({
    id: COMPANY,
    timezone: SP,
  } as unknown as Business);

  entitlements.getBusinessEntitlements.mockResolvedValue([
    { module: "FLEET", enabled: true },
    { module: "DELIVERIES", enabled: true },
  ]);

  dashboard.data.entityCounts.delivery = [
    { count: 3, date: "2026-11-18T15:00:00.000Z", businessId: COMPANY },
    { count: 2, date: "2026-10-05T15:00:00.000Z", businessId: COMPANY },
  ];
});

afterEach(async () => {
  await dashboardRollupShadowIdle();
  env.DASHBOARD_ROLLUP_MODE = initialMode;
  vi.useRealTimers();
});

describe("sameBuckets", () => {
  it("ignores empty buckets and the order, never a count or a period", () => {
    expect(
      sameBuckets(
        [day("2026-11-18"), { period: "2026-11-17", count: 0 }, day("x")],
        [day("x"), day("2026-11-18")],
      ),
    ).toBe(true);
    expect(sameBuckets([day("a")], [{ period: "a", count: 2 }])).toBe(false);
    expect(sameBuckets([day("a")], [day("b")])).toBe(false);
    expect(sameBuckets([day("a"), day("b")], [day("a")])).toBe(false);
  });
});

describe("deliveriesFromRollup", () => {
  it("reads the rollup only with on, and only when the view shows the series", () => {
    expect(deliveriesFromRollup("on", true, NOW)).toEqual({ now: NOW });
    expect(deliveriesFromRollup("on", false, NOW)).toBeUndefined();
    expect(deliveriesFromRollup("shadow", true, NOW)).toBeUndefined();
    expect(deliveriesFromRollup("off", true, NOW)).toBeUndefined();
  });
});

describe("readWithRollup", () => {
  it("reads without the rollup when there is none to read", async () => {
    const read = vi.fn().mockResolvedValue("live");

    await expect(readWithRollup(undefined, read, "trends")).resolves.toBe(
      "live",
    );
    expect(read.mock.calls).toEqual([[undefined]]);
  });

  it("serves the live count when the rollup read fails, counted and logged", async () => {
    const rollup = { now: NOW };
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("relation does not exist"))
      .mockResolvedValueOnce("live");

    await expect(readWithRollup(rollup, read, "overview")).resolves.toBe(
      "live",
    );
    expect(read.mock.calls).toEqual([[rollup], [undefined]]);
    expect(dashboardRollupMetrics().on_fallbacks).toBe(1);
    expect(logged("warn").map((line) => line.msg)).toEqual([
      "dashboard rollup read failed; deliveries counted live",
    ]);
  });
});

describe("the shadow comparison", () => {
  const window = businessDayWindow(NOW, SP, 7);
  const served = {
    from: window.start,
    to: window.end,
    granularity: "day" as const,
  };

  it("agrees when the rollup gives what was served, with one statement", async () => {
    const spy = vi.spyOn(dashboard, "countDeliveryWindows");

    shadowDeliveryRollup({
      repository: dashboard,
      screen: "trends",
      businessId: COMPANY,
      timeZone: SP,
      now: NOW,
      windows: [{ ...served, served: [{ period: "2026-11-18", count: 3 }] }],
    });
    await dashboardRollupShadowIdle();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sources: ["rollup"] });
    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 1,
      windows_agreed: 1,
      windows_raced: 0,
      windows_diverged: 0,
      last_divergence_at: null,
    });
  });

  it("calls it a race when one snapshot agrees with itself: the data moved", async () => {
    const spy = vi.spyOn(dashboard, "countDeliveryWindows");

    // Served before a delivery was created; the rollup and a live count of
    // one snapshot both see it.
    shadowDeliveryRollup({
      repository: dashboard,
      screen: "trends",
      businessId: COMPANY,
      timeZone: SP,
      now: NOW,
      windows: [{ ...served, served: [{ period: "2026-11-18", count: 2 }] }],
    });
    await dashboardRollupShadowIdle();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toMatchObject({ sources: ["live", "rollup"] });
    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 1,
      windows_raced: 1,
      windows_diverged: 0,
    });
    expect(logged("warn")).toEqual([]);
  });

  it("calls it a divergence only when one snapshot disagrees, counted and logged with the window", async () => {
    const live = [{ period: "2026-11-18", count: 3 }];
    const wrong = [{ period: "2026-11-18", count: 4 }];

    vi.spyOn(dashboard, "countDeliveryWindows")
      .mockResolvedValueOnce([{ rollup: wrong }, { rollup: live }])
      .mockResolvedValueOnce([{ live, rollup: wrong }]);

    shadowDeliveryRollup({
      repository: dashboard,
      screen: "overview",
      businessId: COMPANY,
      timeZone: SP,
      now: NOW,
      windows: [
        { ...served, served: live },
        { ...served, served: live },
      ],
    });
    await dashboardRollupShadowIdle();

    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 2,
      windows_agreed: 1,
      windows_diverged: 1,
      last_divergence_at: NOW.toISOString(),
    });

    const [line] = logged("warn");

    expect(line).toMatchObject({
      msg: "dashboard rollup diverged from the live count",
      screen: "overview",
      businessId: COMPANY,
      timeZone: SP,
      window: {
        from: window.start.toISOString(),
        to: window.end.toISOString(),
        granularity: "day",
      },
      live,
      rollup: wrong,
    });
  });

  it("compares one view at a time per process and skips the rest", async () => {
    let release!: () => void;

    vi.spyOn(dashboard, "countDeliveryWindows").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ rollup: [] }]);
        }),
    );

    const input = {
      repository: dashboard,
      screen: "trends" as const,
      businessId: COMPANY,
      timeZone: SP,
      now: NOW,
      windows: [{ ...served, served: [] }],
    };

    shadowDeliveryRollup(input);
    shadowDeliveryRollup(input);
    shadowDeliveryRollup(input);

    expect(dashboardRollupMetrics().views_skipped).toBe(2);

    release();
    await dashboardRollupShadowIdle();

    shadowDeliveryRollup(input);
    await dashboardRollupShadowIdle();

    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 2,
      views_skipped: 2,
    });
  });

  it("never throws into the view: a failed comparison is counted and logged", async () => {
    vi.spyOn(dashboard, "countDeliveryWindows").mockRejectedValueOnce(
      new Error("canceling statement due to statement timeout"),
    );

    expect(() =>
      shadowDeliveryRollup({
        repository: dashboard,
        screen: "trends",
        businessId: COMPANY,
        timeZone: SP,
        now: NOW,
        windows: [{ ...served, served: [] }],
      }),
    ).not.toThrow();
    await dashboardRollupShadowIdle();

    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 0,
      failures: 1,
    });
    expect(logged("warn").map((line) => line.msg)).toEqual([
      "dashboard rollup comparison failed",
    ]);
  });

  it("runs outside the request that started it, which it outlives", async () => {
    let seen: unknown = "not called";

    vi.spyOn(dashboard, "countDeliveryWindows").mockImplementationOnce(
      async () => {
        seen = getRequestContext();

        return [{ rollup: [] }];
      },
    );

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        enterRequestContext({ requestId: "request-of-the-view" });
        shadowDeliveryRollup({
          repository: dashboard,
          screen: "trends",
          businessId: COMPANY,
          timeZone: SP,
          now: NOW,
          windows: [{ ...served, served: [] }],
        });
        resolve();
      });
    });
    await dashboardRollupShadowIdle();

    expect(seen).toBeUndefined();
  });
});

describe("the overview", () => {
  it("with shadow, serves the live count and compares its two windows after", async () => {
    env.DASHBOARD_ROLLUP_MODE = "shadow";

    const byMonth = vi.spyOn(dashboard, "countManyByMonth");
    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    const answer = await overview().execute({ userId: ADMIN });

    await dashboardRollupShadowIdle();

    expect(answer.counts.deliveries).toMatchObject({
      currentMonth: 3,
      lastMonth: 2,
    });
    expect(byMonth.mock.calls[0][0].deliveriesFromRollup).toBeUndefined();

    const months = businessMonthWindow(NOW, SP, 6);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]).toEqual([
      {
        windows: [
          { from: months.start, to: months.end, granularity: "month" },
          {
            from: new Date("2026-10-01T03:00:00.000Z"),
            to: new Date("2026-10-19T18:00:00.000Z"),
            granularity: "month",
          },
        ],
        timeZone: SP,
        now: NOW,
        sources: ["rollup"],
      },
      COMPANY,
    ]);
    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 2,
      windows_agreed: 2,
    });
  });

  it("with on, reads the series from the rollup in both grouped reads", async () => {
    env.DASHBOARD_ROLLUP_MODE = "on";

    const byMonth = vi.spyOn(dashboard, "countManyByMonth");
    const byPeriod = vi.spyOn(dashboard, "countManyByPeriod");
    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    const answer = await overview().execute({ userId: ADMIN });

    expect(answer.counts.deliveries.currentMonth).toBe(3);
    expect(byMonth.mock.calls[0][0].deliveriesFromRollup).toEqual({
      now: NOW,
    });
    // The last-month span: the call after the one countManyByMonth makes.
    expect(
      byPeriod.mock.calls.map((call) => call[0].deliveriesFromRollup),
    ).toEqual([{ now: NOW }, { now: NOW }]);
    expect(compare).not.toHaveBeenCalled();
  });

  it("with off, neither reads the rollup nor compares", async () => {
    env.DASHBOARD_ROLLUP_MODE = "off";

    const byPeriod = vi.spyOn(dashboard, "countManyByPeriod");
    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    await overview().execute({ userId: ADMIN });
    await dashboardRollupShadowIdle();

    expect(
      byPeriod.mock.calls.every((call) => !call[0].deliveriesFromRollup),
    ).toBe(true);
    expect(compare).not.toHaveBeenCalled();
  });

  it("leaves a company without Entregas out of the rollup in every mode", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "FLEET", enabled: true },
      { module: "DELIVERIES", enabled: false },
    ]);

    const byPeriod = vi.spyOn(dashboard, "countManyByPeriod");
    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    for (const mode of ["shadow", "on"] as const) {
      env.DASHBOARD_ROLLUP_MODE = mode;
      await overview().execute({ userId: ADMIN });
      await dashboardRollupShadowIdle();
    }

    expect(
      byPeriod.mock.calls.every((call) => !call[0].deliveriesFromRollup),
    ).toBe(true);
    expect(compare).not.toHaveBeenCalled();
  });

  it("compares the MASTER's platform numbers without a company", async () => {
    env.DASHBOARD_ROLLUP_MODE = "shadow";

    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    await overview().execute({ userId: MASTER });
    await dashboardRollupShadowIdle();

    expect(compare.mock.calls[0][1]).toBeUndefined();
    expect(compare.mock.calls[0][0].timeZone).toBe(SP);
  });
});

describe("the trends", () => {
  it("with shadow, compares the window the chart drew", async () => {
    env.DASHBOARD_ROLLUP_MODE = "shadow";

    const compare = vi.spyOn(dashboard, "countDeliveryWindows");

    const answer = await trends().execute({ userId: ADMIN, period: "7d" });

    await dashboardRollupShadowIdle();

    const window = businessDayWindow(NOW, SP, 7);

    expect(answer.activityTrends.map((point) => point.deliveries)).toEqual([
      0, 0, 0, 0, 0, 3, 0,
    ]);
    expect(compare.mock.calls[0][0].windows).toEqual([
      { from: window.start, to: window.end, granularity: "day" },
    ]);
    expect(dashboardRollupMetrics().windows_agreed).toBe(1);
  });

  it("with on, reads the series from the rollup and serves the same chart", async () => {
    env.DASHBOARD_ROLLUP_MODE = "off";
    const before = await trends().execute({ userId: ADMIN, period: "12m" });

    env.DASHBOARD_ROLLUP_MODE = "on";
    const byPeriod = vi.spyOn(dashboard, "countManyByPeriod");
    const after = await trends().execute({ userId: ADMIN, period: "12m" });

    expect(byPeriod.mock.calls[0][0].deliveriesFromRollup).toEqual({
      now: NOW,
    });
    expect(after).toEqual(before);
  });

  it("serves the live chart when the rollup read fails, never a 500", async () => {
    env.DASHBOARD_ROLLUP_MODE = "on";

    const live = await trends().execute({ userId: ADMIN, period: "30d" });

    vi.spyOn(dashboard, "countManyByPeriod").mockRejectedValueOnce(
      new Error("permission denied for table tenant_day_count"),
    );

    await expect(
      trends().execute({ userId: ADMIN, period: "30d" }),
    ).resolves.toEqual(live);
    expect(dashboardRollupMetrics().on_fallbacks).toBe(1);
  });
});
