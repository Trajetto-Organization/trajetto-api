import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";

import {
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";
import { env } from "@/env";
import {
  tenantSnapshotMemory,
  type TenantSnapshot,
} from "@/shared/cache/tenant-snapshot";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The dashboard's snapshot per company and visibility, over real HTTP
 * (plano-escala F4-23, decision D2): one profile is never shown another's
 * numbers.
 *
 * The overview and the trend chart are kept for DASHBOARD_SNAPSHOT_TTL_MS
 * (60 s) per company and per what the viewer may see. Two profiles of one
 * carrier see different things: the fleet profile reads the vehicles and
 * the maintenance costs, the dispatch profile the drivers, the deliveries
 * and today's operation. Whichever of them computes a copy first, the other
 * must be answered its own numbers, byte for byte the body the route gives
 * with the snapshot off; a colleague with the same grants shares the copy;
 * a profile that loses a grant, or a company that switches a module off,
 * is never served the copy of what it could see; and another carrier with
 * the same visibility reads its own.
 *
 * Over HTTP, because the visibility comes from the session (the profile's
 * permissions and the company's modules are read by its one statement on
 * every request) and the body from the route's response schema.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd530-0000-7000-8000-00000000000a";
const OTHER = "018fd530-0000-7000-8000-00000000000b";

const initialTtl = env.DASHBOARD_SNAPSHOT_TTL_MS;

const tokens = {
  admin: "",
  fleet: "",
  fleetTwin: "",
  dispatch: "",
  otherAdmin: "",
};

let dispatchProfile = "";
let plates = 0;

async function vehicle(businessId: string): Promise<void> {
  plates += 1;

  await seedVehicle(prisma, businessId, {
    plate: `DSN${String(plates).padStart(4, "0")}`,
  });
}

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER, ["FLEET", "DELIVERIES"]);
  await seedCarrier(prisma, OTHER, ["FLEET", "DELIVERIES"]);

  const fleetGrants = [
    { key: "vehicle_manage", write: false },
    { key: "service_order_manage", write: false },
  ];
  const fleetProfile = await seedProfile(prisma, CARRIER, fleetGrants);

  // Another profile, under another name, with the same grants.
  const twinProfile = await seedProfile(prisma, CARRIER, fleetGrants);

  dispatchProfile = await seedProfile(prisma, CARRIER, [
    { key: "delivery_manage", write: false },
    { key: "driver_manage", write: false },
  ]);

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);

  tokens.admin = admin.token;
  tokens.fleet = (
    await seedUser(prisma, "Frota", "BUSINESS_USER", CARRIER, {
      profileAccessId: fleetProfile,
    })
  ).token;
  tokens.fleetTwin = (
    await seedUser(prisma, "Frota também", "BUSINESS_USER", CARRIER, {
      profileAccessId: twinProfile,
    })
  ).token;
  tokens.dispatch = (
    await seedUser(prisma, "Despacho", "BUSINESS_USER", CARRIER, {
      profileAccessId: dispatchProfile,
    })
  ).token;
  tokens.otherAdmin = (
    await seedUser(prisma, "Outra gestora", "BUSINESS_ADMIN", OTHER)
  ).token;

  const branchId = await seedBranch(prisma, CARRIER, "Matriz");
  const vehicleId = await seedVehicle(prisma, CARRIER, { plate: "DSN9A01" });

  await vehicle(CARRIER);
  await seedDriver(prisma, CARRIER);
  await prisma.serviceOrder.create({
    data: {
      maintenance_type: "INTERNAL",
      total_amount: 130,
      businessId: CARRIER,
      branchId,
      vehicleId,
      responsibleUserId: admin.id,
    },
  });

  for (let index = 0; index < 5; index += 1) await vehicle(OTHER);
  await seedDriver(prisma, OTHER);
  await seedDriver(prisma, OTHER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

beforeEach(() => {
  env.DASHBOARD_SNAPSHOT_TTL_MS = 60_000;
  tenantSnapshotMemory().clear();
});

afterAll(async () => {
  env.DASHBOARD_SNAPSHOT_TTL_MS = initialTtl;
  await app?.close();
  await prisma.$disconnect();
});

const OVERVIEW = "/dashboard/overview";

async function read(token: string, url: string): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  return response.body;
}

/** The body the route gives with the snapshot off: the answer of before. */
async function alone(token: string, url: string): Promise<string> {
  const ttl = env.DASHBOARD_SNAPSHOT_TTL_MS;

  env.DASHBOARD_SNAPSHOT_TTL_MS = 0;

  try {
    return await read(token, url);
  } finally {
    env.DASHBOARD_SNAPSHOT_TTL_MS = ttl;
  }
}

function computes(
  token: "DashboardOverviewSnapshots" | "DashboardTrendsSnapshots",
) {
  return container.resolve<TenantSnapshot<unknown>>(token).stats().computes;
}

describe("the overview through the company's snapshot", () => {
  it("shows the two profiles different things: what the key must keep apart", async () => {
    const fleet = JSON.parse(await alone(tokens.fleet, OVERVIEW));
    const dispatch = JSON.parse(await alone(tokens.dispatch, OVERVIEW));

    expect(fleet.counts.vehicles.value).toBe(2);
    expect(fleet.counts.drivers.value).toBe(0);
    expect(fleet.maintenanceCosts.at(-1)).toMatchObject({ internal: 130 });
    expect(fleet.deliveryOperation).toBeNull();
    expect(fleet.activityTrends[0]).not.toHaveProperty("deliveries");

    expect(dispatch.counts.vehicles.value).toBe(0);
    expect(dispatch.counts.drivers.value).toBe(1);
    expect(dispatch.maintenanceCosts).toEqual([]);
    expect(dispatch.deliveryOperation).not.toBeNull();
    expect(dispatch.activityTrends[0]).toHaveProperty("deliveries");
  });

  it.each([
    ["the fleet profile first", ["fleet", "dispatch", "admin", "fleetTwin"]],
    ["the dispatch profile first", ["dispatch", "fleetTwin", "admin", "fleet"]],
  ] as const)(
    "answers each profile its own body, %s",
    async (_order, arrivals) => {
      const expected = new Map<string, string>();

      for (const who of arrivals) {
        expected.set(who, await alone(tokens[who], OVERVIEW));
      }

      const before = computes("DashboardOverviewSnapshots");

      for (const who of arrivals) {
        expect(await read(tokens[who], OVERVIEW), who).toBe(expected.get(who));
      }

      // The fleet profile and its twin were one computation.
      expect(computes("DashboardOverviewSnapshots") - before).toBe(3);
    },
  );

  it("serves a colleague with the same grants the copy, and nobody else", async () => {
    const first = JSON.parse(await read(tokens.fleet, OVERVIEW));

    // The vehicle stays: every later test compares against a read alone.
    await vehicle(CARRIER);

    const twin = JSON.parse(await read(tokens.fleetTwin, OVERVIEW));
    const admin = JSON.parse(await read(tokens.admin, OVERVIEW));

    // The twin is handed the copy, read before the new vehicle; the admin,
    // who also sees the vehicles but more besides, a read of its own.
    expect(twin.counts.vehicles.value).toBe(first.counts.vehicles.value);
    expect(admin.counts.vehicles.value).toBe(first.counts.vehicles.value + 1);

    // With the snapshot off, the read of before.
    const off = JSON.parse(await alone(tokens.fleet, OVERVIEW));

    expect(off.counts.vehicles.value).toBe(first.counts.vehicles.value + 1);
  });

  it("never serves a profile that lost a grant the copy of what it could see", async () => {
    const before = JSON.parse(await read(tokens.dispatch, OVERVIEW));

    expect(before.deliveryOperation).not.toBeNull();

    await prisma.permission.updateMany({
      where: {
        profileAccessId: dispatchProfile,
        permissionKey: "delivery_manage",
      },
      data: { canRead: false },
    });

    try {
      const after = await read(tokens.dispatch, OVERVIEW);
      const parsed = JSON.parse(after);

      expect(parsed.deliveryOperation).toBeNull();
      expect(parsed.counts.deliveries.value).toBe(0);
      expect(parsed.activityTrends[0]).not.toHaveProperty("deliveries");
      expect(after).toBe(await alone(tokens.dispatch, OVERVIEW));
    } finally {
      await prisma.permission.updateMany({
        where: {
          profileAccessId: dispatchProfile,
          permissionKey: "delivery_manage",
        },
        data: { canRead: true },
      });
    }
  });

  it("never serves another carrier with the same visibility this one's copy", async () => {
    const expected = await alone(tokens.otherAdmin, OVERVIEW);

    await read(tokens.admin, OVERVIEW);

    const other = await read(tokens.otherAdmin, OVERVIEW);

    expect(other).toBe(expected);
    expect(JSON.parse(other).counts.vehicles.value).toBe(5);
  });
});

describe("the trend chart through the company's snapshot", () => {
  const CHARTS = [
    "/dashboard/trends?period=7d",
    "/dashboard/trends?period=30d",
    "/dashboard/trends?period=12m",
  ];

  it("keeps a chart per company and period, each the body read alone", async () => {
    const expected = new Map<string, string>();

    for (const url of CHARTS) {
      expected.set(`a ${url}`, await alone(tokens.admin, url));
      expected.set(`b ${url}`, await alone(tokens.otherAdmin, url));
    }

    const before = computes("DashboardTrendsSnapshots");

    for (const url of CHARTS) {
      expect(await read(tokens.admin, url), url).toBe(expected.get(`a ${url}`));
      expect(await read(tokens.otherAdmin, url), url).toBe(
        expected.get(`b ${url}`),
      );
      expect(await read(tokens.admin, url), url).toBe(expected.get(`a ${url}`));
    }

    expect(computes("DashboardTrendsSnapshots") - before).toBe(
      CHARTS.length * 2,
    );
  });

  it("never serves a carrier that switched Frotas off the chart of when it had it", async () => {
    const url = "/dashboard/trends?period=7d";
    const before = JSON.parse(await read(tokens.admin, url));

    expect(before.maintenanceCosts).not.toEqual([]);

    await prisma.businessEntitlement.updateMany({
      where: { businessId: CARRIER, module: "FLEET" },
      data: { enabled: false },
    });

    try {
      const after = await read(tokens.admin, url);

      expect(JSON.parse(after).maintenanceCosts).toEqual([]);
      expect(after).toBe(await alone(tokens.admin, url));
    } finally {
      await prisma.businessEntitlement.updateMany({
        where: { businessId: CARRIER, module: "FLEET" },
        data: { enabled: true },
      });
    }
  });
});
