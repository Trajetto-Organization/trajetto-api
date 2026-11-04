import { afterAll, beforeAll, describe } from "vitest";

import { VehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/vehicle-checklist-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import type { VehicleChecklist } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";

import {
  ROUTE_CHECKLIST_FIXTURE as F,
  ROUTE_CHECKLIST_SEED,
  ROUTE_SEED,
  routeChecklistContract,
  type RouteChecklistHarness,
} from "../contract/repositories/vehicle-checklist.contract";
import { KINDS, clone, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedVehicle,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Plan of 02/11/2026 (C4): the route checklists read against Postgres and
 * the twin.
 */
const prisma = createPrismaClient();
const memory = new InMemoryVehicleChecklistRepository();

const harnesses: Record<Kind, () => RouteChecklistHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new VehicleChecklistRepository(prisma),
  }),
  "in-memory": () => ({ kind: "in-memory", repo: memory }),
};

/** The columns a checklist needs besides the ones the contract is about. */
function filler(businessId: string) {
  const own = businessId === F.A;

  return {
    current_mileage: 1_000,
    tires_condition: "good",
    bumpers_condition: "good",
    windshield_condition: "good",
    mirrors_condition: "good",
    steering_wheel_condition: "good",
    battery_condition: "good",
    spare_tire_condition: "good",
    photos: [],
    branchId: own ? F.branchA : F.branchB,
    vehicleId: own ? F.vehicleA : F.vehicleB,
    driverId: own ? F.driverA : F.driverB,
  };
}

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await seedBranch(prisma, F.A, 1, F.branchA);
  await seedBranch(prisma, F.B, 2, F.branchB);
  await seedDriver(prisma, F.A, 1, { id: F.driverA });
  await seedDriver(prisma, F.B, 2, { id: F.driverB });
  await seedVehicle(prisma, F.A, "CHK1A11", { id: F.vehicleA });
  await seedVehicle(prisma, F.B, "CHK2B22", { id: F.vehicleB });

  for (const { vehicle, ...route } of ROUTE_SEED) {
    await prisma.route.create({
      data: {
        ...route,
        vehicleId: vehicle?.id ?? null,
        scheduled_date: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
  }

  memory.routes.push(...clone(ROUTE_SEED));

  await prisma.vehicleChecklist.createMany({
    data: ROUTE_CHECKLIST_SEED.map((row) => ({
      ...filler(row.businessId),
      ...row,
    })),
  });

  memory.checklists.push(
    ...clone(ROUTE_CHECKLIST_SEED).map(
      (row) =>
        ({
          ...filler(row.businessId),
          ...row,
          created_at: row.checklist_date,
          updated_at: row.checklist_date,
        }) as unknown as VehicleChecklist,
    ),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("vehicle checklist route read (%s)", (kind) => {
  routeChecklistContract(harnesses[kind]);
});
