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
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the vehicle contract against Postgres and the twin. */
const prisma = createPrismaClient();

const prismaRepo = new VehicleRepository(prisma);
const memory = new InMemoryVehicleRepository();

const ids: Partial<Record<Kind, Map<string, string>>> = {};

const harnessOf = (kind: Kind): VehicleHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key: string) => {
    const id = ids[kind]?.get(key);
    if (!id) throw new Error(`no vehicle ${key}`);
    return id;
  },
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
  await seedBranch(prisma, F.A, 1, F.branchA).then((row) =>
    prisma.branch.update({
      where: { id: row.id },
      data: { corporate_reason: F.branchName },
    }),
  );

  memory.driverNames[F.driverA] = F.driverName;
  memory.vehicleTypeNames[F.vehicleTypeA] = F.vehicleTypeName;
  memory.branchNames[F.branchA] = F.branchName;

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
