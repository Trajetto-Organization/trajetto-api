import { afterAll, beforeAll, describe } from "vitest";

import { PrismaClient } from "@prisma/client";

import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";

import {
  FUEL_FIXTURE as F,
  FUEL_SEED,
  fuelRepositoryContract,
  type FuelHarness,
} from "../contract/repositories/fuel.contract";
import { KINDS, minute, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedFuelType,
  seedVehicle,
} from "../contract/seed";

/** Decision 13.2: the fuel contract against Postgres and the twin. */
const prisma = new PrismaClient();
const prismaRepo = new FuelRepository(prisma);
const memory = new InMemoryFuelRepository();

const ids: Partial<Record<Kind, Map<string, string>>> = {};

const harnessOf = (kind: Kind): FuelHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key) => {
    const id = ids[kind]?.get(key);
    if (!id) throw new Error(`no refueling ${key}`);
    return id;
  },
});

const harnesses: Record<Kind, FuelHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

const DRIVERS = [
  { id: F.dA1, businessId: F.A, name: "Marcos Prado", cnh: "60000000001" },
  { id: F.dA2, businessId: F.A, name: "joão", cnh: "60000000002" },
  { id: F.dB, businessId: F.B, name: "Marcos Bravo", cnh: "60000000009" },
] as const;

const VEHICLES = [
  { id: F.vA1, businessId: F.A, plate: F.plateA1 },
  { id: F.vA2, businessId: F.A, plate: F.plateA2 },
  { id: F.vB, businessId: F.B, plate: F.plateB },
] as const;

async function seedPostgres(): Promise<void> {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await seedBranch(prisma, F.A, 1, F.branchA);
  await seedBranch(prisma, F.B, 2, F.branchB);

  const typeA = await seedFuelType(prisma, F.A, "Diesel S10");
  const typeB = await seedFuelType(prisma, F.B, "Diesel S10");
  await prisma.fuelType.update({
    where: { id: typeA.id },
    data: { id: F.typeA },
  });
  await prisma.fuelType.update({
    where: { id: typeB.id },
    data: { id: F.typeB },
  });

  for (const [n, driver] of DRIVERS.entries()) {
    await seedDriver(prisma, driver.businessId, n + 1, {
      id: driver.id,
      name: driver.name,
      cnh: driver.cnh,
    });
  }

  for (const vehicle of VEHICLES) {
    await seedVehicle(prisma, vehicle.businessId, vehicle.plate, {
      id: vehicle.id,
      fuelTypeId: vehicle.businessId === F.A ? F.typeA : F.typeB,
    });
  }
}

function seedTwin(): void {
  memory.branches.set(F.branchA, {
    businessId: F.A,
    corporate_reason: "Filial Contrato 1",
  });
  memory.branches.set(F.branchB, {
    businessId: F.B,
    corporate_reason: "Filial Contrato 2",
  });

  for (const vehicle of VEHICLES) {
    memory.vehicles.set(vehicle.id, {
      businessId: vehicle.businessId,
      license_plate: vehicle.plate,
      description: `Caminhão ${vehicle.plate}`,
      brand: "Scania",
      model: "R450",
    });
  }

  for (const driver of DRIVERS) {
    memory.drivers.set(driver.id, { name: driver.name, cnh: driver.cnh });
  }

  memory.fuelTypes.set(F.typeA, { businessId: F.A, description: "Diesel S10" });
  memory.fuelTypes.set(F.typeB, { businessId: F.B, description: "Diesel S10" });
}

beforeAll(async () => {
  await seedPostgres();
  seedTwin();

  for (const kind of KINDS) {
    const created = new Map<string, string>();

    for (const row of FUEL_SEED) {
      const fuel = await harnesses[kind].repo.createFuel(row.data);
      created.set(row.key, fuel.id);

      if (kind === "prisma") {
        await prisma.fuel.update({
          where: { id: fuel.id },
          data: { created_at: minute(row.minute) },
        });
      } else {
        memory.fuels.find((entry) => entry.id === fuel.id)!.created_at = minute(
          row.minute,
        );
      }
    }

    ids[kind] = created;
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("fuel repository (%s)", (kind) => {
  fuelRepositoryContract(() => harnesses[kind]);
});
