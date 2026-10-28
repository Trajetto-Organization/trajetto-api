import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entitlements = vi.hoisted(() => ({ getBusinessEntitlements: vi.fn() }));

// The module table is SQL (the dashboard E2E suites read it for real); here
// only what the use case does with the answer.
vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryDashboardRepository } from "@/modules/dashboard/repositories/in-memory/in-memory-dashboard-repository";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";

import {
  GetDashboardOverviewUseCase,
  type OverviewNumbers,
} from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { SnapshotCache } from "@/shared/cache/snapshot-cache";
import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";

/**
 * The dashboard use cases on the in-memory twins: whose rows are counted,
 * in which company's calendar, and which series a viewer receives at all.
 */
const A = "018f5300-0000-7000-8000-00000000000a";
const B = "018f5300-0000-7000-8000-00000000000b";

const ADMIN_A = "018f5300-0000-7000-8000-0000000000a1";
const CLERK_A = "018f5300-0000-7000-8000-0000000000a2";
const MASTER = "018f5300-0000-7000-8000-0000000000f1";

const CLERK_PROFILE = "018f5300-0000-7000-8000-0000000000e1";

// 02:00 UTC on 06/10 is still 05/10, 23:00 in São Paulo.
const NOW = new Date("2026-10-06T02:00:00.000Z");

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let dashboard: InMemoryDashboardRepository;
let activities: InMemoryActivityRepository;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  dashboard = new InMemoryDashboardRepository();
  activities = new InMemoryActivityRepository();

  users.profiles.set(CLERK_PROFILE, { name: "Só motoristas" } as never);
  users.profilePermissions.set(CLERK_PROFILE, [
    { permissionKey: "driver_manage", canRead: true, canWrite: false },
  ] as never);

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    {
      id: CLERK_A,
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: CLERK_PROFILE,
    } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: A, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: B, timezone: "America/Manaus" } as unknown as Business,
  );

  // Only Frotas hired: Entregas is off for A.
  entitlements.getBusinessEntitlements.mockResolvedValue([
    { module: "FLEET", enabled: true },
    { module: "DELIVERIES", enabled: false },
  ]);

  // 30/09 23:00 in São Paulo (already October in UTC): September's.
  dashboard.addEntityCount("vehicle", 1, "2026-10-01T02:00:00.000Z", A);
  dashboard.addEntityCount("vehicle", 2, "2026-10-03T15:00:00.000Z", A);
  dashboard.addEntityCount("vehicle", 50, "2026-10-03T15:00:00.000Z", B);
  dashboard.addEntityCount("driver", 4, "2026-10-06T01:30:00.000Z", A);
  dashboard.addEntityCount("delivery", 9, "2026-10-03T15:00:00.000Z", A);
  dashboard.addMonthlyCost(300, 100, "2026-10-02T15:00:00.000Z", A);
  dashboard.addMonthlyCost(9999, 9999, "2026-10-02T15:00:00.000Z", B);
});

afterEach(() => {
  vi.useRealTimers();
});

const overview = () =>
  new GetDashboardOverviewUseCase(
    users,
    dashboard,
    activities,
    new InMemoryDeliveryRepository(),
    businesses,
    new InMemoryOperationDayRepository(),
  );

const trends = () =>
  new GetDashboardTrendsUseCase(users, dashboard, businesses);

describe("GetDashboardOverviewUseCase", () => {
  it("counts the admin's company by its own months, never another company's rows", async () => {
    const result = await overview().execute({ userId: ADMIN_A });

    // A catalogue's card is its total (3 vehicles), compared with the total
    // when the company's October began (1, created on 30/09 in São Paulo).
    expect(result.counts.vehicles).toEqual({
      currentMonth: 2,
      lastMonth: 1,
      basis: "total",
      value: 3,
      previous: 1,
    });
    expect(result.counts.drivers).toEqual({
      currentMonth: 4,
      lastMonth: 0,
      basis: "total",
      value: 4,
      previous: 0,
    });
    expect(result.activityTrends.map((point) => point.month)).toEqual([
      "Mai",
      "Jun",
      "Jul",
      "Ago",
      "Set",
      "Out",
    ]);
    expect(result.maintenanceCosts[result.maintenanceCosts.length - 1]).toEqual(
      { month: "Out", internal: 300, external: 100 },
    );
  });

  it("leaves the series of a module the company did not hire out of the chart, and the operation null", async () => {
    const result = await overview().execute({ userId: ADMIN_A });

    expect(result.activityTrends[5]).not.toHaveProperty("deliveries");
    expect(result.activityTrends[5]).not.toHaveProperty("routes");
    // The company's own admin never draws the "Empresas" line.
    expect(result.activityTrends[5]).not.toHaveProperty("businesses");
    // A hidden entity keeps the documented shape, as zero.
    expect(result.counts.deliveries).toEqual({
      currentMonth: 0,
      lastMonth: 0,
      basis: "month_to_date",
      value: 0,
      previous: 0,
    });
    expect(result.deliveryOperation).toBeNull();
  });

  it("shows the drivers registered before this month in the card, not 0 and -100%", async () => {
    // Twenty drivers registered in August, none since: the card read 0.
    dashboard.addEntityCount("driver", 20, "2026-08-10T15:00:00.000Z", A);

    const result = await overview().execute({ userId: ADMIN_A });

    expect(result.counts.drivers.value).toBe(24);
    expect(result.counts.drivers.previous).toBe(20);
  });

  it("compares an operation's month so far with last month up to the same point", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "FLEET", enabled: true },
      { module: "DELIVERIES", enabled: true },
    ]);
    // Now is 05/10 23:00 in São Paulo: 05/09 counts, 20/09 does not.
    dashboard.addEntityCount("delivery", 4, "2026-09-05T12:00:00.000Z", A);
    dashboard.addEntityCount("delivery", 7, "2026-09-20T12:00:00.000Z", A);

    const result = await overview().execute({ userId: ADMIN_A });

    expect(result.counts.deliveries).toMatchObject({
      basis: "month_to_date",
      value: 9,
      previous: 4,
      lastMonth: 11,
    });
  });

  it("gives the day's operation to a company with Entregas", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "FLEET", enabled: true },
      { module: "DELIVERIES", enabled: true },
    ]);

    const result = await overview().execute({ userId: ADMIN_A });

    expect(result.deliveryOperation).not.toBeNull();
    expect(result.activityTrends[5]).toMatchObject({ deliveries: 9 });
  });

  it("drops the costs without Frotas", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue([
      { module: "DELIVERIES", enabled: true },
    ]);

    const result = await overview().execute({ userId: ADMIN_A });

    expect(result.maintenanceCosts).toEqual([]);
    expect(result.maintenanceStats).toEqual({
      pending: 0,
      recent: 0,
      overdue: 0,
    });
  });

  it("shows a restricted profile only the series it may read", async () => {
    const result = await overview().execute({ userId: CLERK_A });

    expect(Object.keys(result.activityTrends[5]).sort()).toEqual([
      "drivers",
      "month",
    ]);
    expect(result.vehicleStatus).toEqual({
      ACTIVE: 0,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });
    expect(result.maintenanceCosts).toEqual([]);
    expect(result.deliveryOperation).toBeNull();
  });

  it("gives the MASTER the platform's numbers, with no company asked about modules", async () => {
    const result = await overview().execute({ userId: MASTER });

    expect(entitlements.getBusinessEntitlements).not.toHaveBeenCalled();
    expect(result.counts.vehicles.currentMonth).toBe(52);
    expect(result.counts.vehicles.value).toBe(53);
    expect(result.deliveryOperation).toBeNull();
  });

  /**
   * The MASTER's counts are over the whole platform — the heaviest reads of
   * the screen, the same for every MASTER — and are served from a one-minute
   * snapshot shared by the replicas. Only those: the activity feed names
   * people and is read on every view, and a company's numbers never touch
   * the snapshot.
   */
  it("serves the MASTER's platform numbers from the snapshot, the feed fresh", async () => {
    const snapshots = new SnapshotCache<OverviewNumbers>({
      name: "test-master-overview",
      ttlMs: 60_000,
      store: null,
    });
    const withSnapshots = new GetDashboardOverviewUseCase(
      users,
      dashboard,
      activities,
      new InMemoryDeliveryRepository(),
      businesses,
      new InMemoryOperationDayRepository(),
      snapshots,
    );

    const counted = vi.spyOn(dashboard, "countManyByMonth");
    const feed = vi.spyOn(activities, "listRecentActivitiesPreview");

    const first = await withSnapshots.execute({ userId: MASTER });

    dashboard.addEntityCount("vehicle", 7, "2026-10-04T15:00:00.000Z", B);

    const second = await withSnapshots.execute({ userId: MASTER });

    expect(counted).toHaveBeenCalledTimes(1);
    expect(second.counts).toEqual(first.counts);
    expect(feed).toHaveBeenCalledTimes(2);

    // A company's overview is never served from it.
    const admin = await withSnapshots.execute({ userId: ADMIN_A });

    expect(counted).toHaveBeenCalledTimes(2);
    expect(admin.counts.vehicles.value).toBe(3);
  });

  it("uses the modules the session already loaded instead of reading them again", async () => {
    const result = await overview().execute({
      userId: ADMIN_A,
      entitlements: [
        { module: "FLEET", enabled: true },
        { module: "DELIVERIES", enabled: true },
      ],
    });

    expect(entitlements.getBusinessEntitlements).not.toHaveBeenCalled();
    // Entregas is on in the session's copy: the operation is summarised.
    expect(result.deliveryOperation).not.toBeNull();
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      overview().execute({ userId: "nobody" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("GetDashboardTrendsUseCase", () => {
  it("buckets 7 days in the company's calendar, today included, labelled as days", async () => {
    const result = await trends().execute({ userId: ADMIN_A, period: "7d" });

    expect(result.activityTrends).toHaveLength(7);
    expect(
      result.activityTrends[result.activityTrends.length - 1],
    ).toMatchObject({ date: "05 de out.", drivers: 4 });
    expect(
      result.activityTrends.find((point) => point.date === "03 de out."),
    ).toMatchObject({ vehicles: 2 });
    expect(
      result.activityTrends[result.activityTrends.length - 1],
    ).not.toHaveProperty("deliveries");
    expect(
      result.maintenanceCosts.find((point) => point.date === "02 de out."),
    ).toEqual({
      date: "02 de out.",
      internal: 300,
      external: 100,
    });
  });

  it.each([
    ["30d", 30],
    ["3m", 4],
    ["6m", 7],
    ["12m", 13],
  ] as const)("draws %s as %i points", async (period, points) => {
    const result = await trends().execute({ userId: ADMIN_A, period });

    expect(result.activityTrends).toHaveLength(points);
    expect(result.maintenanceCosts).toHaveLength(points);
  });

  it("files a month by the company's zone: 30/09 23:00 in São Paulo is September", async () => {
    const result = await trends().execute({ userId: ADMIN_A, period: "3m" });

    expect(result.activityTrends.slice(-2)).toEqual([
      expect.objectContaining({ date: "Set", vehicles: 1 }),
      expect.objectContaining({ date: "Out", vehicles: 2 }),
    ]);
  });

  it("sends no costs to a profile that cannot read service orders", async () => {
    const result = await trends().execute({ userId: CLERK_A, period: "7d" });

    expect(result.maintenanceCosts).toEqual([]);
    expect(Object.keys(result.activityTrends[0]).sort()).toEqual([
      "date",
      "drivers",
    ]);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      trends().execute({ userId: "nobody", period: "7d" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});
