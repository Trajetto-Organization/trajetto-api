import { afterAll, describe, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import { FuelTypeRepository } from "@/modules/fuel-type/repositories/fuel-type-repository";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { VehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/vehicle-checklist-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import { VehicleTypeRepository } from "@/modules/vehicle-type/repositories/vehicle-type-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import {
  KINDS,
  expectPrismaCode,
  fixedId,
  type Kind,
} from "../contract/support";

/**
 * TEST-PAR-2, for the fleet catalogs: an update or delete of an id that is
 * not there is P2025 in Postgres, and must be in the twin. The twins threw a
 * bare `Error("... not found")`, which a use case's P2025 branch never
 * recognised, so a unit test proved a 500 where the API answers 404.
 */
const prisma = new PrismaClient();
const MISSING = fixedId("0f0f", 99);

interface Repos {
  bills: AccountPayableRepository | InMemoryAccountPayableRepository;
  fuelTypes: FuelTypeRepository | InMemoryFuelTypeRepository;
  fuels: FuelRepository | InMemoryFuelRepository;
  orders: ServiceOrderRepository | InMemoryServiceOrderRepository;
  suppliers: SupplierRepository | InMemorySupplierRepository;
  vehicles: VehicleRepository | InMemoryVehicleRepository;
  checklists: VehicleChecklistRepository | InMemoryVehicleChecklistRepository;
  vehicleTypes: VehicleTypeRepository | InMemoryVehicleTypeRepository;
}

const repos: Record<Kind, Repos> = {
  prisma: {
    bills: new AccountPayableRepository(prisma),
    fuelTypes: new FuelTypeRepository(prisma),
    fuels: new FuelRepository(prisma),
    orders: new ServiceOrderRepository(prisma),
    suppliers: new SupplierRepository(prisma),
    vehicles: new VehicleRepository(prisma),
    checklists: new VehicleChecklistRepository(prisma),
    vehicleTypes: new VehicleTypeRepository(prisma),
  },
  "in-memory": {
    bills: new InMemoryAccountPayableRepository(),
    fuelTypes: new InMemoryFuelTypeRepository(),
    fuels: new InMemoryFuelRepository(),
    orders: new InMemoryServiceOrderRepository(),
    suppliers: new InMemorySupplierRepository(),
    vehicles: new InMemoryVehicleRepository(),
    checklists: new InMemoryVehicleChecklistRepository(),
    vehicleTypes: new InMemoryVehicleTypeRepository(),
  },
};

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)(
  "writes on a fleet row that does not exist (%s)",
  (kind) => {
    const r = () => repos[kind];

    it("account payable: update is P2025", async () => {
      await expectPrismaCode(
        r().bills.updateAccountPayable({
          accountPayableId: MISSING,
          accountPayableData: { payee_name: "Ninguém" },
        }),
        "P2025",
      );
    });

    it("fuel type: update and delete are P2025", async () => {
      await expectPrismaCode(
        r().fuelTypes.updateFuelType({
          fuelTypeId: MISSING,
          fuelTypeData: { description: "X" },
        }),
        "P2025",
      );
      await expectPrismaCode(r().fuelTypes.deleteFuelType(MISSING), "P2025");
    });

    it("fuel: update and delete are P2025", async () => {
      await expectPrismaCode(
        r().fuels.updateFuel({ fuelId: MISSING, fuelData: { notes: "X" } }),
        "P2025",
      );
      await expectPrismaCode(r().fuels.deleteFuel(MISSING), "P2025");
    });

    it("service order: update is P2025", async () => {
      await expectPrismaCode(
        r().orders.updateServiceOrder({
          serviceOrderId: MISSING,
          serviceOrderData: { description: "X" },
        }),
        "P2025",
      );
    });

    it("supplier: update is P2025", async () => {
      await expectPrismaCode(
        r().suppliers.updateSupplier({
          supplierId: MISSING,
          supplierData: { name: "X" },
        }),
        "P2025",
      );
    });

    it("vehicle: update and delete are P2025", async () => {
      await expectPrismaCode(
        r().vehicles.updateVehicle({
          vehicleId: MISSING,
          vehicleData: { description: "X" },
        }),
        "P2025",
      );
      await expectPrismaCode(r().vehicles.deleteVehicle(MISSING), "P2025");
    });

    it("checklist: update is P2025", async () => {
      await expectPrismaCode(
        r().checklists.updateVehicleChecklist({
          checklistId: MISSING,
          checklistData: { tires_condition: "OK" } as never,
        }),
        "P2025",
      );
    });

    it("vehicle type: update and delete are P2025", async () => {
      await expectPrismaCode(
        r().vehicleTypes.updateVehicleType({
          vehicleTypeId: MISSING,
          vehicleTypeData: { description: "X" },
        }),
        "P2025",
      );
      await expectPrismaCode(
        r().vehicleTypes.deleteVehicleType(MISSING),
        "P2025",
      );
    });
  },
);
