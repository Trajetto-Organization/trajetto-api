import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";

import {
  businessDateKey,
  dateOnlyFromKey,
  shiftDateKey,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

/**
 * The trend chart: what it costs, and whose calendar it draws.
 *
 * Cost: for "30d" the old loop was 30 × 9 + 30 = 300 round trips, with nine
 * concurrent connections per bucket. Two queries now, whatever the window.
 *
 * Calendar: the buckets are the company's civil days (`Business.timezone`).
 * The carrier here is in Manaus (UTC-4), which is neither the container's
 * zone (UTC) nor a São Paulo developer machine's, so a grouping that falls
 * back to the process zone files the late-night row under the wrong day
 * wherever this runs.
 *
 * Visibility: a series is present only when the viewer may see it and the
 * company hired its module (DLVP-ADM-1, DASH-MOD-1).
 */
const prisma = new PrismaClient();

/** A second client, with query logging on, so the queries can be counted. */
const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

const MANAUS = "America/Manaus";

const CARRIER = "018fd300-0000-7000-8000-00000000000a";
const MANAGER = "018fd300-0000-7000-8000-0000000000a1";
const SHIPPER = "018fd300-0000-7000-8000-0000000000f1";

// Deliveries only (no Frotas) and Frotas only (no Entregas), one admin each.
const DELIVERIES_ONLY = "018fd300-0000-7000-8000-00000000000b";
const DELIVERIES_ADMIN = "018fd300-0000-7000-8000-0000000000b1";
const FLEET_ONLY = "018fd300-0000-7000-8000-00000000000c";
const FLEET_ADMIN = "018fd300-0000-7000-8000-0000000000c1";

let profileId = "";

let queries = 0;

/** A wall-clock moment in Manaus, `daysAgo` civil days before its today. */
function at(daysAgo: number, hour = 12, minute = 0): Date {
  const key = shiftDateKey(businessDateKey(new Date(), MANAUS), -daysAgo);
  const day = dateOnlyFromKey(key);

  return zonedWallTimeToUtc(
    MANAUS,
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    hour,
    minute,
  );
}

/** The label the chart puts under that day. */
function label(daysAgo: number): string {
  return dateOnlyFromKey(
    shiftDateKey(businessDateKey(new Date(), MANAUS), -daysAgo),
  ).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
}

async function runTrends(
  period: "7d" | "30d" | "6m",
  userId: string = MANAGER,
): Promise<any> {
  const useCase = new GetDashboardTrendsUseCase(
    new UserRepository(),
    new DashboardRepository(counted),
    new BusinessRepository(),
  );

  queries = 0;

  return useCase.execute({ userId, period });
}

async function seedBusiness(id: string, label: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: label,
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      cnpj: String(80000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "92999999999",
      email: `tendencia-${randomUUID()}@exemplo.com.br`,
      timezone: MANAUS,
    },
  });
}

beforeAll(async () => {
  counted.$on("query" as never, () => {
    queries += 1;
  });

  await seedBusiness(CARRIER, "Transportadora das Tendências");
  await seedBusiness(DELIVERIES_ONLY, "Transportadora só de Entregas");
  await seedBusiness(FLEET_ONLY, "Transportadora só de Frota");

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: CARRIER, module: "DELIVERIES", enabled: true },
      { businessId: DELIVERIES_ONLY, module: "DELIVERIES", enabled: true },
      { businessId: DELIVERIES_ONLY, module: "FLEET", enabled: false },
      { businessId: FLEET_ONLY, module: "FLEET", enabled: true },
    ],
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Gestão",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
          {
            permissionKey: "vehicle_manage",
            action: "Gerenciar veículos",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.createMany({
    data: [
      {
        id: MANAGER,
        name: "Gestora",
        email: `gestora-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: profile.id,
      },
      {
        id: DELIVERIES_ADMIN,
        name: "Admin de Entregas",
        email: `admin-entregas-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: DELIVERIES_ONLY,
      },
      {
        id: FLEET_ADMIN,
        name: "Admin de Frota",
        email: `admin-frota-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: FLEET_ONLY,
      },
    ],
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  /**
   * Different counts on different days, on purpose: a chart where every
   * bucket holds the same number cannot tell a correct grouping from one that
   * files everything under the same key.
   *
   * - one TODAY, because the window's last bucket is today and an end
   *   boundary at midnight silently drops the day people are looking at;
   * - one at 23:30 three days ago in Manaus: 00:30 of the next day in São
   *   Paulo and 03:30 in UTC. Grouped in either of those zones it lands one
   *   bucket to the right.
   */
  const moments: Array<[daysAgo: number, hour: number, minute: number]> = [
    [0, 12, 0],
    [1, 12, 0],
    [1, 12, 0],
    [1, 12, 0],
    [2, 12, 0],
    [3, 23, 30],
    [5, 12, 0],
  ];

  await prisma.delivery.createMany({
    data: moments.map(([daysAgo, hour, minute], index) => ({
      businessId: CARRIER,
      shipperId: SHIPPER,
      code: `TR${index}`,
      recipient_name: "Cliente",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      status: "PENDING" as const,
      created_at: at(daysAgo, hour, minute),
    })),
  });
}, 180_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.shipper.deleteMany({ where: { id: SHIPPER } });

  await prisma.user.deleteMany({
    where: { id: { in: [MANAGER, DELIVERIES_ADMIN, FLEET_ADMIN] } },
  });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [CARRIER, DELIVERIES_ONLY, FLEET_ONLY] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, DELIVERIES_ONLY, FLEET_ONLY] } },
  });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("how much the chart costs", () => {
  it("draws thirty days in a handful of queries, not three hundred", async () => {
    await runTrends("30d");

    // One union covers every entity of every day; the costs would be a
    // second, and this profile cannot read them. Two is the ceiling.
    expect(queries).toBeLessThanOrEqual(2);
  });

  it("does not get more expensive as the window grows", async () => {
    await runTrends("7d");
    const short = queries;

    await runTrends("6m");
    const long = queries;

    // The old shape charged per bucket, so a longer window cost strictly
    // more. Grouped, the window is a WHERE clause.
    expect(long).toBe(short);
  });
});

describe("and whether it is right, in the company's calendar", () => {
  it("puts each day's deliveries in the company's day", async () => {
    const trends = await runTrends("30d");

    const points = trends.activityTrends;

    // 30 days back through today, inclusive.
    expect(points).toHaveLength(30);
    expect(points.at(-1).date, "o último ponto não é o hoje da empresa").toBe(label(0));

    const bucketFor = (daysAgo: number) =>
      points.find((point: any) => point.date === label(daysAgo));

    expect(bucketFor(1)?.deliveries).toBe(3);
    expect(bucketFor(2)?.deliveries).toBe(1);
    expect(bucketFor(5)?.deliveries).toBe(1);

    // Today, the window's last bucket. An end boundary at midnight drops it.
    expect(bucketFor(0)?.deliveries, "o último dia sumiu da janela").toBe(1);

    // 23:30 in Manaus: in any other zone this row moves to day 2.
    expect(bucketFor(3)?.deliveries, "o fim da noite caiu no dia seguinte").toBe(1);

    // A day with nothing is zero and present: the chart draws a point for it.
    expect(bucketFor(4)?.deliveries).toBe(0);
  });

  it("collapses the same rows into months when the window is long", async () => {
    const trends = await runTrends("6m");

    const total = trends.activityTrends.reduce(
      (sum: number, point: any) => sum + point.deliveries,
      0,
    );

    expect(trends.activityTrends).toHaveLength(7);
    expect(total).toBe(7);
  });
});

describe("the series a viewer receives", () => {
  it("leaves out what the profile may not read", async () => {
    const trends = await runTrends("30d");

    for (const point of trends.activityTrends) {
      // No permission: no key, so no line (a zero drew a flat one).
      expect(point).not.toHaveProperty("fines");
      expect(point).not.toHaveProperty("parts");
      expect(point).not.toHaveProperty("serviceOrders");

      // Allowed: present, a number even on an empty day.
      expect(point.vehicles).toBe(0);
      expect(typeof point.deliveries).toBe("number");
      expect(typeof point.routes).toBe("number");
    }

    expect(trends.maintenanceCosts).toEqual([]);
  });

  it("gives a company without Frotas no fleet series and no costs", async () => {
    const trends = await runTrends("7d", DELIVERIES_ADMIN);

    for (const point of trends.activityTrends) {
      for (const key of ["parts", "suppliers", "serviceOrders", "fines", "businesses"]) {
        expect(point, key).not.toHaveProperty(key);
      }

      expect(point.deliveries).toBe(0);
      expect(point.vehicles).toBe(0);
    }

    expect(trends.maintenanceCosts).toEqual([]);
  });

  it("gives a company without Entregas no delivery series", async () => {
    const trends = await runTrends("7d", FLEET_ADMIN);

    for (const point of trends.activityTrends) {
      expect(point).not.toHaveProperty("deliveries");
      expect(point).not.toHaveProperty("routes");
      expect(point.serviceOrders).toBe(0);
    }

    expect(trends.maintenanceCosts).toHaveLength(7);
  });
});
