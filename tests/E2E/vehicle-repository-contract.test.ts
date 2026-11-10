import { afterAll, beforeAll, describe } from "vitest";

import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import {
  VEHICLE_FIXTURE as F,
  seedVehicles,
  vehicleRepositoryContract,
  type VehicleHarness,
} from "../contract/repositories/vehicle.contract";
import { KINDS, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedFuelType,
  seedUser,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the vehicle contract against Postgres and the twin. */
const prisma = createPrismaClient();

const prismaRepo = new VehicleRepository(prisma);
const memory = new InMemoryVehicleRepository();

// The route twin's rows, for the status a truck taken out of BLOCKED gets.
const memoryRoutes: Array<{
  vehicleId: string;
  driverId: string;
  status: string;
  businessId: string;
}> = [];

memory.routeSource = () => memoryRoutes;

const ids: Partial<Record<Kind, Map<string, string>>> = {};

let routeCode = 900;

/** An IN_PROGRESS route of A with this vehicle, in the table or the twin. */
async function routeOnTheRoad(
  kind: Kind,
  vehicleId: string,
): Promise<() => Promise<void>> {
  if (kind === "in-memory") {
    const row = {
      vehicleId,
      driverId: F.driverA,
      status: "IN_PROGRESS",
      businessId: F.A,
    };

    memoryRoutes.push(row);

    return async () => {
      row.status = "COMPLETED";
    };
  }

  routeCode += 1;

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      status: "IN_PROGRESS",
      scheduled_date: new Date("2026-09-10T00:00:00.000Z"),
      started_at: new Date(),
      businessId: F.A,
      driverId: F.driverA,
      vehicleId,
    },
  });

  return async () => {
    await prisma.route.update({
      where: { id: route.id },
      data: { status: "COMPLETED", completed_at: new Date() },
    });
  };
}

const harnessOf = (kind: Kind): VehicleHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key: string) => {
    const id = ids[kind]?.get(key);
    if (!id) throw new Error(`no vehicle ${key}`);
    return id;
  },
  routeOnTheRoad: (vehicleId: string) => routeOnTheRoad(kind, vehicleId),
});

const harnesses: Record<Kind, VehicleHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await prisma.fuelType.create({
    data: { id: F.fuelTypeA, description: "Diesel", businessId: F.A },
  });
  await seedFuelType(prisma, F.B).then((row) =>
    prisma.fuelType.update({
      where: { id: row.id },
      data: { id: F.fuelTypeB },
    }),
  );
  await prisma.vehicleType.create({
    data: {
      id: F.vehicleTypeA,
      description: F.vehicleTypeName,
      number_of_axles: 3,
      businessId: F.A,
    },
  });
  await seedDriver(prisma, F.A, 1, { id: F.driverA, name: F.driverName });
  await seedUser(prisma, F.A, 1, {
    id: F.responsibleA,
    role: "BUSINESS_ADMIN",
  });
  await seedBranch(prisma, F.A, 1, F.branchA).then((row) =>
    prisma.branch.update({
      where: { id: row.id },
      data: { corporate_reason: F.branchName },
    }),
  );

  memory.driverNames[F.driverA] = F.driverName;
  memory.vehicleTypeNames[F.vehicleTypeA] = F.vehicleTypeName;
  memory.branchNames[F.branchA] = F.branchName;
  memory.userNames[F.responsibleA] = F.responsibleName;

  ids.prisma = await seedVehicles(prismaRepo, async (id, at) => {
    await prisma.vehicle.update({ where: { id }, data: { created_at: at } });
  });
  ids["in-memory"] = await seedVehicles(memory, async (id, at) => {
    memory.vehicles.find((row) => row.id === id)!.created_at = at;
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("vehicle repository (%s)", (kind) => {
  vehicleRepositoryContract(() => harnesses[kind]);
});
