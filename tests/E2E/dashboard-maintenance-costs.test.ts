import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  seedBranch,
  seedCarrier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";

/**
 * The maintenance cost chart, over real HTTP (FLEET-SO-3).
 *
 * The series are named by where the work was done — `internal` and
 * `external`, the two values of MaintenanceType — and no longer
 * "preventive/corrective", which the column never recorded. Over HTTP because
 * the zod response schema strips what it does not list: a key renamed in the
 * use case but not in the schema would vanish from the body.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd400-0000-7000-8000-00000000000a";
const OTHER = "018fd400-0000-7000-8000-00000000000b";

let adminToken = "";

async function order(
  businessId: string,
  data: { type: "INTERNAL" | "EXTERNAL"; amount: number },
  refs: { branchId: string; vehicleId: string; userId: string },
): Promise<void> {
  await prisma.serviceOrder.create({
    data: {
      maintenance_type: data.type,
      total_amount: data.amount,
      businessId,
      branchId: refs.branchId,
      vehicleId: refs.vehicleId,
      responsibleUserId: refs.userId,
    },
  });
}

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER, ["FLEET"]);
  await seedCarrier(prisma, OTHER, ["FLEET"]);

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  adminToken = admin.token;

  const refs = {
    branchId: await seedBranch(prisma, CARRIER, "Matriz"),
    vehicleId: await seedVehicle(prisma, CARRIER, { plate: "CST1A11" }),
    userId: admin.id,
  };

  await order(CARRIER, { type: "INTERNAL", amount: 100 }, refs);
  await order(CARRIER, { type: "INTERNAL", amount: 30 }, refs);
  await order(CARRIER, { type: "EXTERNAL", amount: 40 }, refs);

  // Another company's work never reaches this chart.
  const other = await seedUser(prisma, "Outra", "BUSINESS_ADMIN", OTHER);
  await order(
    OTHER,
    { type: "EXTERNAL", amount: 999 },
    {
      branchId: await seedBranch(prisma, OTHER, "Outra matriz"),
      vehicleId: await seedVehicle(prisma, OTHER, { plate: "CST2B22" }),
      userId: other.id,
    },
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function get(url: string): Promise<any> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${adminToken}` },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  return response.json();
}

describe("the maintenance cost series", () => {
  it("are named internal and external on the overview, by the order's type", async () => {
    const overview = await get("/dashboard/overview");

    const current = overview.maintenanceCosts.at(-1);

    expect(current).toEqual({
      month: expect.any(String),
      internal: 130,
      external: 40,
    });

    for (const point of overview.maintenanceCosts) {
      expect(Object.keys(point).sort()).toEqual([
        "external",
        "internal",
        "month",
      ]);
    }
  });

  it("and on the trend by day, with the same totals", async () => {
    const trends = await get("/dashboard/trends?period=7d");

    const total = (key: "internal" | "external") =>
      trends.maintenanceCosts.reduce(
        (sum: number, point: any) => sum + point[key],
        0,
      );

    expect(total("internal")).toBe(130);
    expect(total("external")).toBe(40);

    for (const point of trends.maintenanceCosts) {
      expect(Object.keys(point).sort()).toEqual([
        "date",
        "external",
        "internal",
      ]);
    }
  });
});
