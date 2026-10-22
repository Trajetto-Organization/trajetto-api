import { describe, expect, it, vi } from "vitest";

import { CreateServiceOrderUseCase } from "@/modules/service-order/usecases/create-service-order/create-service-order-usecase";
import { UpdateServiceOrderUseCase } from "@/modules/service-order/usecases/update-service-order/update-service-order-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { KanbanService } from "@/shared/services/kanban-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * A completed service order and the vehicle's odometer (IDEMP-15).
 *
 * The order's new mileage was validated against a read taken before the
 * order was written, and then written to the vehicle AFTER the commit with a
 * plain update. A refuelling at 120.500 km committed in between was undone by
 * the order's 120.300 km: the counter went backwards, and every maintenance
 * alert computed from it with it. Fuel and checklists already only ever move
 * the counter forward, inside their own transaction.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const BRANCH = "018f0000-0000-7000-8000-0000000000b1";

const outboxStub = { publish: async () => {} } as unknown as OutboxService;

const kanbanStub = {
  createCardFromServiceOrder: () => {},
} as unknown as KanbanService;

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const businessRepository = new InMemoryBusinessRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const branchRepository = new InMemoryBranchRepository();
  const serviceOrderRepository = new InMemoryServiceOrderRepository();

  userRepository.user.push({
    id: USER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  // With the column defaults (timezone), as the real row has them.
  businessRepository.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
  } as unknown as Business);

  branchRepository.branches.push({
    id: BRANCH,
    businessId: BUSINESS,
  } as Branch);

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    businessId: BUSINESS,
    current_mileage: 120_000,
    maintenance_interval_km: 10_000,
    last_maintenance_mileage: 110_000,
  } as Vehicle);

  return {
    vehicleRepository,
    serviceOrderRepository,
    updateServiceOrder: new UpdateServiceOrderUseCase(
      userRepository,
      businessRepository,
      vehicleRepository,
      branchRepository,
      new InMemorySupplierRepository(),
      serviceOrderRepository,
      outboxStub,
    ),
    createServiceOrder: new CreateServiceOrderUseCase(
      userRepository,
      businessRepository,
      vehicleRepository,
      branchRepository,
      new InMemorySupplierRepository(),
      serviceOrderRepository,
      outboxStub,
      kanbanStub,
    ),
  };
}

const completedOrder = (newMileage: number) => ({
  date: new Date("2026-09-20"),
  completion_date: new Date("2026-09-21"),
  maintenance_type: "INTERNAL" as const,
  total_amount: 350,
  current_mileage_at_service: 120_000,
  maintenance_interval_km_at_service: 10_000,
  last_maintenance_mileage_at_service: 110_000,
  new_mileage_after_service: newMileage,
  businessId: BUSINESS,
  vehicleId: VEHICLE,
  responsibleUserId: USER,
  branchId: BRANCH,
  created_from: "WEB_DASHBOARD" as const,
});

describe("a completed service order moving the odometer", () => {
  it("never moves it backwards past a reading that landed in between", async () => {
    const context = makeContext();

    // A refuelling at 120.500 km commits right after the order read the
    // vehicle: the order validates against 120.000, the row holds 120.500.
    const read = context.vehicleRepository.findVehicleById.bind(
      context.vehicleRepository,
    );

    context.vehicleRepository.findVehicleById = async (...args) => {
      const snapshot = await read(...args);
      const stale = snapshot ? { ...snapshot } : null;

      context.vehicleRepository.vehicles[0].current_mileage = 120_500;

      return stale;
    };

    await expect(
      context.createServiceOrder.execute(completedOrder(120_300), USER),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(context.vehicleRepository.vehicles[0].current_mileage).toBe(120_500);

    // Refused as a whole: the order does not exist without its mileage.
    expect(context.serviceOrderRepository.serviceOrders).toHaveLength(0);
  });

  it("does the same when an open order is finished later", async () => {
    const context = makeContext();

    const open = await context.createServiceOrder.execute(
      {
        ...completedOrder(0),
        completion_date: null,
        new_mileage_after_service: null,
      },
      USER,
    );

    const read = context.vehicleRepository.findVehicleById.bind(
      context.vehicleRepository,
    );

    context.vehicleRepository.findVehicleById = async (...args) => {
      const snapshot = await read(...args);
      const stale = snapshot ? { ...snapshot } : null;

      context.vehicleRepository.vehicles[0].current_mileage = 120_500;

      return stale;
    };

    await expect(
      context.updateServiceOrder.execute(
        {
          completion_date: new Date("2026-09-22"),
          new_mileage_after_service: 120_300,
        },
        open.id,
        BUSINESS,
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(context.vehicleRepository.vehicles[0].current_mileage).toBe(120_500);
  });

  it("moves it forward, with the maintenance, when nothing got in the way", async () => {
    const context = makeContext();

    await context.createServiceOrder.execute(completedOrder(120_300), USER);

    const [vehicle] = context.vehicleRepository.vehicles;

    expect(vehicle.current_mileage).toBe(120_300);
    expect(vehicle.last_maintenance_mileage).toBe(120_300);
  });
});
