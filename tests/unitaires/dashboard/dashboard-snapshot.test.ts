import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entitlements = vi.hoisted(() => ({ getBusinessEntitlements: vi.fn() }));

// The module table is SQL; every read here hands the session's copy, and
// the mock proves it is not asked again.
vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);

import { env } from "@/env";
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
import {
  GetDashboardTrendsUseCase,
  type DashboardTrendsResponse,
} from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";
import {
  dashboardSnapshot,
  overviewVariant,
  trendsVariant,
  type OverviewVisibility,
} from "@/modules/dashboard/usecases/shared/dashboard-snapshot";
import {
  TenantSnapshotMemory,
  type TenantSnapshot,
} from "@/shared/cache/tenant-snapshot";

/**
 * The dashboard's 60-second snapshot per company and visibility
 * (plano-escala F4-23, decision D2): one profile is never shown another's
 * numbers.
 *
 * The overview and the trend chart depend on who asks: a profile limited
 * to the fleet must never receive the deliveries a dispatcher's copy
 * counted, nor a colleague who lost a permission the copy of what they
 * could see. The proof is against reading alone: whatever order the
 * viewers arrive in, and whoever computed the copy, each one is handed
 * exactly the numbers its own read without the snapshot gives. And the
 * snapshot does its job: viewers who may see the same things share one
 * computation.
 */
const A = "018f5310-0000-7000-8000-00000000000a";
const B = "018f5310-0000-7000-8000-00000000000b";

const ADMIN_A = "018f5310-0000-7000-8000-0000000000a1";
const FLEET_A = "018f5310-0000-7000-8000-0000000000a2";
const FLEET_TWIN_A = "018f5310-0000-7000-8000-0000000000a3";
const DISPATCH_A = "018f5310-0000-7000-8000-0000000000a4";
const LINKED_A = "018f5310-0000-7000-8000-0000000000a5";
const WRITER_A = "018f5310-0000-7000-8000-0000000000a6";
const ADMIN_B = "018f5310-0000-7000-8000-0000000000b1";
const MASTER = "018f5310-0000-7000-8000-0000000000f1";

const FLEET_PROFILE = "018f5310-0000-7000-8000-0000000000e1";
const FLEET_TWIN_PROFILE = "018f5310-0000-7000-8000-0000000000e2";
const DISPATCH_PROFILE = "018f5310-0000-7000-8000-0000000000e3";
const WRITER_PROFILE = "018f5310-0000-7000-8000-0000000000e4";

const VIEWERS = [
  ADMIN_A,
  FLEET_A,
  FLEET_TWIN_A,
  DISPATCH_A,
  LINKED_A,
  WRITER_A,
  ADMIN_B,
];

/** The two profiles with the same grants share a copy; nobody else does. */
const DISTINCT_VISIBILITIES = VIEWERS.length - 1;

const BOTH_MODULES = [
  { module: "FLEET", enabled: true },
  { module: "DELIVERIES", enabled: true },
];

const NOW = new Date("2026-10-06T15:00:00.000Z");

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let dashboard: InMemoryDashboardRepository;
let activities: InMemoryActivityRepository;

const initialTtl = env.DASHBOARD_SNAPSHOT_TTL_MS;

function grant(key: string, canRead = true, canWrite = false) {
  return { permissionKey: key, canRead, canWrite };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  env.DASHBOARD_SNAPSHOT_TTL_MS = 60_000;

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  dashboard = new InMemoryDashboardRepository();
  activities = new InMemoryActivityRepository();

  const profiles: Array<[string, ReturnType<typeof grant>[]]> = [
    [FLEET_PROFILE, [grant("vehicle_manage"), grant("service_order_manage")]],
    // Another profile, other name, the same grants.
    [
      FLEET_TWIN_PROFILE,
      [grant("service_order_manage"), grant("vehicle_manage")],
    ],
    [DISPATCH_PROFILE, [grant("delivery_manage"), grant("driver_manage")]],
    // Write without read is no access (ROUTE-KEY-1).
    [WRITER_PROFILE, [grant("vehicle_manage", false, true)]],
  ];

  for (const [id, permissions] of profiles) {
    users.profiles.set(id, { name: id.slice(-2) } as never);
    users.profilePermissions.set(id, permissions as never);
  }

  const clerk = (id: string, profile: string, extra = {}) =>
    ({
      id,
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profile,
      ...extra,
    }) as unknown as User;

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    clerk(FLEET_A, FLEET_PROFILE),
    clerk(FLEET_TWIN_A, FLEET_TWIN_PROFILE),
    clerk(DISPATCH_A, DISPATCH_PROFILE),
    // Dispatch's grants, but linked to a driver: never the whole operation.
    clerk(LINKED_A, DISPATCH_PROFILE, {
      driverId: "018f5310-0000-7000-8000-0000000000d1",
    }),
    clerk(WRITER_A, WRITER_PROFILE),
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: A, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: B, timezone: "America/Sao_Paulo" } as unknown as Business,
  );

  dashboard.addEntityCount("vehicle", 3, "2026-10-03T15:00:00.000Z", A);
  dashboard.addEntityCount("vehicle", 50, "2026-10-03T15:00:00.000Z", B);
  dashboard.addEntityCount("driver", 4, "2026-10-04T15:00:00.000Z", A);
  dashboard.addEntityCount("delivery", 9, "2026-10-05T15:00:00.000Z", A);
  dashboard.addEntityCount("delivery", 70, "2026-10-05T15:00:00.000Z", B);
  dashboard.addEntityCount("service-order", 2, "2026-10-02T15:00:00.000Z", A);
  dashboard.addMonthlyCost(300, 100, "2026-10-02T15:00:00.000Z", A);
  dashboard.addMonthlyCost(9999, 9999, "2026-10-02T15:00:00.000Z", B);
  dashboard.addVehicleType("Caminhão", 3, A);
  dashboard.addVehicleType("Carreta", 50, B);
});

afterEach(() => {
  env.DASHBOARD_SNAPSHOT_TTL_MS = initialTtl;
  vi.useRealTimers();
});

const overview = (snapshot?: TenantSnapshot<OverviewNumbers>) =>
  new GetDashboardOverviewUseCase(
    users,
    dashboard,
    activities,
    new InMemoryDeliveryRepository(),
    businesses,
    new InMemoryOperationDayRepository(),
    undefined,
    snapshot,
  );

const trends = (snapshot?: TenantSnapshot<DashboardTrendsResponse>) =>
  new GetDashboardTrendsUseCase(users, dashboard, businesses, snapshot);

let names = 0;

/** A snapshot of its own, in a memory of its own: no test shares copies. */
function fresh<T>(): TenantSnapshot<T> {
  names += 1;

  return dashboardSnapshot<T>(
    `test-dashboard-${names}`,
    new TenantSnapshotMemory(8 * 1024 * 1024),
  );
}

const overviewAlone = (userId: string) =>
  overview().execute({ userId, entitlements: BOTH_MODULES });

describe("the overview through the company's snapshot", () => {
  it("is not the same for every viewer: the case the snapshot must keep apart", async () => {
    const fleet = await overviewAlone(FLEET_A);
    const dispatch = await overviewAlone(DISPATCH_A);
    const linked = await overviewAlone(LINKED_A);
    const otherCompany = await overviewAlone(ADMIN_B);

    expect(fleet.counts.deliveries.value).toBe(0);
    expect(fleet.maintenanceCosts).toContainEqual(
      expect.objectContaining({ internal: 300 }),
    );
    expect(dispatch.counts.deliveries.value).toBe(9);
    expect(dispatch.maintenanceCosts).toEqual([]);
    expect(dispatch.deliveryOperation).not.toBeNull();
    expect(linked.deliveryOperation).toBeNull();
    expect(otherCompany.counts.vehicles.value).toBe(50);
  });

  it.each([
    ["in order", VIEWERS],
    ["in reverse", [...VIEWERS].reverse()],
  ])(
    "hands each viewer arriving %s exactly the numbers it reads alone",
    async (_order, arrivals) => {
      const snapshot = fresh<OverviewNumbers>();

      for (const userId of arrivals) {
        const alone = await overviewAlone(userId);
        const shared = await overview(snapshot).execute({
          userId,
          entitlements: BOTH_MODULES,
        });

        expect(shared, userId).toStrictEqual(alone);
      }

      // The twins of the fleet profile were one computation; everybody
      // else, a computation of their own.
      expect(snapshot.stats()).toMatchObject({
        computes: DISTINCT_VISIBILITIES,
        copies: 1,
      });
    },
  );

  it("never serves a profile that lost a permission the copy of what it could see", async () => {
    const snapshot = fresh<OverviewNumbers>();

    const before = await overview(snapshot).execute({
      userId: DISPATCH_A,
      entitlements: BOTH_MODULES,
    });

    expect(before.counts.deliveries.value).toBe(9);

    users.profilePermissions.set(DISPATCH_PROFILE, [
      grant("driver_manage"),
    ] as never);

    const after = await overview(snapshot).execute({
      userId: DISPATCH_A,
      entitlements: BOTH_MODULES,
    });

    expect(after).toStrictEqual(await overviewAlone(DISPATCH_A));
    expect(after.counts.deliveries.value).toBe(0);
    expect(after.deliveryOperation).toBeNull();
    expect(after.activityTrends[0]).not.toHaveProperty("deliveries");
  });

  it("never serves a company that switched a module off the copy of when it had it", async () => {
    const snapshot = fresh<OverviewNumbers>();

    await overview(snapshot).execute({
      userId: ADMIN_A,
      entitlements: BOTH_MODULES,
    });

    const withoutFleet = await overview(snapshot).execute({
      userId: ADMIN_A,
      entitlements: [
        { module: "FLEET", enabled: false },
        { module: "DELIVERIES", enabled: true },
      ],
    });

    expect(withoutFleet.maintenanceCosts).toEqual([]);
    expect(withoutFleet.activityTrends[0]).not.toHaveProperty("serviceOrders");
    expect(entitlements.getBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("serves the copy for DASHBOARD_SNAPSHOT_TTL_MS, the activity fresh, then reads again", async () => {
    const snapshot = fresh<OverviewNumbers>();
    const read = () =>
      overview(snapshot).execute({
        userId: ADMIN_A,
        entitlements: BOTH_MODULES,
      });
    const feed = vi.spyOn(activities, "listRecentActivitiesPreview");

    expect((await read()).counts.vehicles.value).toBe(3);

    dashboard.addEntityCount("vehicle", 1, "2026-10-06T14:00:00.000Z", A);

    expect((await read()).counts.vehicles.value).toBe(3);
    expect(feed).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW.getTime() + 60_000);

    expect((await read()).counts.vehicles.value).toBe(4);
  });

  it("reads every view alone with DASHBOARD_SNAPSHOT_TTL_MS=0, as before", async () => {
    env.DASHBOARD_SNAPSHOT_TTL_MS = 0;

    const snapshot = fresh<OverviewNumbers>();
    const read = () =>
      overview(snapshot).execute({
        userId: ADMIN_A,
        entitlements: BOTH_MODULES,
      });

    expect((await read()).counts.vehicles.value).toBe(3);

    dashboard.addEntityCount("vehicle", 1, "2026-10-06T14:00:00.000Z", A);

    expect((await read()).counts.vehicles.value).toBe(4);
    expect(snapshot.stats()).toMatchObject({ computes: 0, copies: 0 });
  });

  it("keeps the MASTER's platform-wide overview out of the company snapshot", async () => {
    const snapshot = fresh<OverviewNumbers>();

    const result = await overview(snapshot).execute({ userId: MASTER });

    expect(result.counts.vehicles.value).toBe(53);
    expect(snapshot.stats()).toMatchObject({ computes: 0, copies: 0 });
  });
});

describe("the trend chart through the company's snapshot", () => {
  it("keeps one chart per company, period and visibility, each the one read alone", async () => {
    const snapshot = fresh<DashboardTrendsResponse>();
    const reads = [
      [ADMIN_A, "7d"],
      [ADMIN_A, "30d"],
      [FLEET_A, "7d"],
      [DISPATCH_A, "7d"],
      [ADMIN_B, "7d"],
      [FLEET_TWIN_A, "7d"],
      [ADMIN_A, "7d"],
    ] as const;

    for (const [userId, period] of reads) {
      const alone = await trends().execute({
        userId,
        period,
        entitlements: BOTH_MODULES,
      });
      const shared = await trends(snapshot).execute({
        userId,
        period,
        entitlements: BOTH_MODULES,
      });

      expect(shared, `${userId} ${period}`).toStrictEqual(alone);
    }

    expect(snapshot.stats()).toMatchObject({ computes: 5, copies: 2 });
    expect(entitlements.getBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("reads the modules only when the session did not bring them", async () => {
    entitlements.getBusinessEntitlements.mockResolvedValue(BOTH_MODULES);

    await trends(fresh()).execute({ userId: ADMIN_A, period: "7d" });

    expect(entitlements.getBusinessEntitlements).toHaveBeenCalledWith(A);
  });
});

describe("the variant", () => {
  const visibility: OverviewVisibility = {
    entities: ["vehicle", "driver", "delivery"],
    vehicles: true,
    maintenance: true,
    costs: true,
    operation: true,
  };

  /**
   * Every input of the computation is in the key: change any one and it
   * is another copy. A part left out would let two viewers who differ by
   * it share one.
   */
  it("changes with every input of the overview's computation", () => {
    const variants = [
      overviewVariant(visibility, "America/Sao_Paulo"),
      overviewVariant(visibility, "America/Manaus"),
      overviewVariant(
        { ...visibility, entities: ["vehicle", "driver"] },
        "America/Sao_Paulo",
      ),
      overviewVariant({ ...visibility, vehicles: false }, "America/Sao_Paulo"),
      overviewVariant(
        { ...visibility, maintenance: false },
        "America/Sao_Paulo",
      ),
      overviewVariant({ ...visibility, costs: false }, "America/Sao_Paulo"),
      overviewVariant({ ...visibility, operation: false }, "America/Sao_Paulo"),
    ].map((variant) => JSON.stringify(variant));

    expect(new Set(variants).size).toBe(variants.length);
  });

  it("changes with every input of the chart's computation", () => {
    const chart = { entities: visibility.entities, costs: true };
    const variants = [
      trendsVariant("7d", chart, "America/Sao_Paulo"),
      trendsVariant("30d", chart, "America/Sao_Paulo"),
      trendsVariant("7d", chart, "America/Manaus"),
      trendsVariant(
        "7d",
        { ...chart, entities: ["vehicle"] },
        "America/Sao_Paulo",
      ),
      trendsVariant("7d", { ...chart, costs: false }, "America/Sao_Paulo"),
    ].map((variant) => JSON.stringify(variant));

    expect(new Set(variants).size).toBe(variants.length);
  });
});
