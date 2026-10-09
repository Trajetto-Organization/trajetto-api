import { describe, expect, it, vi } from "vitest";

import { CreateServiceOrderUseCase } from "@/modules/service-order/usecases/create-service-order/create-service-order-usecase";
import { UpdateServiceOrderUseCase } from "@/modules/service-order/usecases/update-service-order/update-service-order-usecase";
import { DeleteServiceOrderUseCase } from "@/modules/service-order/usecases/delete-service-order/delete-service-order-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { KanbanService } from "@/shared/services/kanban-service";
import type { NotificationService } from "@/shared/services/notification-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * FLEET-SO-4 on the twins: a vehicle that stood in the workshop comes back
 * with the reading it went in with. Finishing its order at that reading was
 * refused ("deve ser maior"), so people typed +0.1 km to close it. And
 * FLEET-SO-1's guard, answered by the twin like the real repository.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const BRANCH = "018f0000-0000-7000-8000-0000000000b1";

const outboxStub = { publish: async () => {} } as unknown as OutboxService;
const kanbanStub = { createCardFromServiceOrder: () => {} } as unknown as KanbanService;
const activities = { createActivityIfEnabled: vi.fn() } as unknown as NotificationService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const vehicles = new InMemoryVehicleRepository();
  const branches = new InMemoryBranchRepository();
  const orders = new InMemoryServiceOrderRepository();
  const suppliers = new InMemorySupplierRepository();

  users.user.push({ id: USER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User);
  businesses.business.push({ ...BUSINESS_COLUMN_DEFAULTS, id: BUSINESS } as unknown as Business);
  branches.branches.push({ id: BRANCH, businessId: BUSINESS } as Branch);

  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    businessId: BUSINESS,
    current_mileage: 120_000,
    maintenance_interval_km: 10_000,
    last_maintenance_mileage: 110_000,
    last_maintenance_date: null,
  } as unknown as Vehicle);

  return {
    vehicles,
    orders,
    create: new CreateServiceOrderUseCase(
      users,
      businesses,
      vehicles,
      branches,
      suppliers,
      orders,
      outboxStub,
      kanbanStub,
    ),
    update: new UpdateServiceOrderUseCase(
      users,
      businesses,
      vehicles,
      branches,
      suppliers,
      orders,
      outboxStub,
    ),
    remove: new DeleteServiceOrderUseCase(users, businesses, orders, activities),
  };
}

const order = (extra: Record<string, unknown> = {}) => ({
  date: new Date("2026-09-20T12:00:00Z"),
  maintenance_type: "INTERNAL" as const,
  total_amount: 350,
  current_mileage_at_service: 120_000,
  maintenance_interval_km_at_service: 10_000,
  last_maintenance_mileage_at_service: 110_000,
  businessId: BUSINESS,
  vehicleId: VEHICLE,
  responsibleUserId: USER,
  branchId: BRANCH,
  created_from: "WEB_DASHBOARD" as const,
  ...extra,
});

describe("finishing a service order at the odometer's reading", () => {
  it("creates it finished and records the maintenance without moving the odometer", async () => {
    const context = makeContext();

    await context.create.execute(
      order({
        completion_date: new Date("2026-09-21T12:00:00Z"),
        new_mileage_after_service: 120_000,
      }),
      USER,
    );

    const vehicle = context.vehicles.vehicles[0];

    expect(context.orders.serviceOrders).toHaveLength(1);
    expect(vehicle.current_mileage).toBe(120_000);
    expect(vehicle.last_maintenance_mileage).toBe(120_000);
    expect(new Date(vehicle.last_maintenance_date as Date).toISOString()).toBe(
      "2026-09-21T12:00:00.000Z",
    );
  });

  it("finishes an open order at the same reading", async () => {
    const context = makeContext();

    const open = await context.create.execute(order(), USER);

    await context.update.execute(
      {
        completion_date: new Date("2026-09-22T12:00:00Z"),
        new_mileage_after_service: 120_000,
      },
      open.id,
      BUSINESS,
      USER,
    );

    const vehicle = context.vehicles.vehicles[0];

    expect(vehicle.current_mileage).toBe(120_000);
    expect(vehicle.last_maintenance_mileage).toBe(120_000);
  });

  it("still refuses a reading behind the odometer, writing nothing", async () => {
    const context = makeContext();

    await expect(
      context.create.execute(
        order({
          completion_date: new Date("2026-09-21T12:00:00Z"),
          new_mileage_after_service: 119_999,
        }),
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_ORDER_MILEAGE_BEHIND" });

    expect(context.orders.serviceOrders).toHaveLength(0);
    expect(context.vehicles.vehicles[0].last_maintenance_mileage).toBe(110_000);
  });

  it("keeps a finished order editable after the odometer moved past its reading", async () => {
    const context = makeContext();

    const finished = await context.create.execute(
      order({
        completion_date: new Date("2026-09-21T12:00:00Z"),
        new_mileage_after_service: 121_000,
      }),
      USER,
    );

    // The next fuel-up moves the odometer on.
    context.vehicles.vehicles[0].current_mileage = 125_000;

    // The edit form posts the stored reading back with the change.
    await context.update.execute(
      { description: "Revisão completa", new_mileage_after_service: 121_000 },
      finished.id,
      BUSINESS,
      USER,
    );

    expect(context.orders.serviceOrders[0].description).toBe("Revisão completa");
    expect(context.vehicles.vehicles[0].current_mileage).toBe(125_000);
    expect(context.vehicles.vehicles[0].last_maintenance_mileage).toBe(121_000);
  });

  it("answers another company's order like a missing one", async () => {
    const context = makeContext();

    const open = await context.create.execute(order(), USER);

    context.orders.serviceOrders[0].businessId = "018f0000-0000-7000-8000-0000000000ff";

    const notFound = { statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" };

    await expect(
      context.update.execute({ description: "x" }, open.id, BUSINESS, USER),
    ).rejects.toMatchObject(notFound);
    await expect(
      context.update.execute({ description: "x" }, "missing", BUSINESS, USER),
    ).rejects.toMatchObject(notFound);
    await expect(context.remove.execute(open.id, BUSINESS, USER)).rejects.toMatchObject(notFound);
  });
});

describe("correcting the reading of a finished order", () => {
  /**
   * The correction is judged against the order's own opening reading, not
   * the live odometer: after the next fuel-up an honest correction (121 000
   * → 122 000 with the odometer at 125 000) was refused, and only a false
   * value above the odometer was accepted.
   */
  async function finishedAt121k() {
    const context = makeContext();

    // Opened at 120 000 km (the snapshot), finished at 121 000.
    const finished = await context.create.execute(
      order({
        completion_date: new Date("2026-09-21T12:00:00Z"),
        new_mileage_after_service: 121_000,
      }),
      USER,
    );

    // The next fuel-up moves the odometer on.
    context.vehicles.vehicles[0].current_mileage = 125_000;

    const correct = (mileage: number) =>
      context.update.execute(
        { new_mileage_after_service: mileage },
        finished.id,
        BUSINESS,
        USER,
      );

    return { context, correct, vehicle: () => context.vehicles.vehicles[0] };
  }

  it("accepts a correction behind the odometer; the last maintenance follows, the odometer stays", async () => {
    const { context, correct, vehicle } = await finishedAt121k();

    await correct(122_000);

    expect(context.orders.serviceOrders[0].new_mileage_after_service).toBe(122_000);
    expect(vehicle().current_mileage).toBe(125_000);
    expect(vehicle().last_maintenance_mileage).toBe(122_000);
    // A correction is not a new maintenance: the date stays.
    expect(new Date(vehicle().last_maintenance_date as Date).toISOString()).toBe(
      "2026-09-21T12:00:00.000Z",
    );
  });

  it("refuses a correction behind the opening reading", async () => {
    const { context, correct, vehicle } = await finishedAt121k();

    await expect(correct(119_000)).rejects.toMatchObject({
      statusCode: 400,
      code: "SERVICE_ORDER_MILEAGE_BEHIND",
      message: expect.stringContaining("abertura da ordem (120000 km)"),
    });

    expect(context.orders.serviceOrders[0].new_mileage_after_service).toBe(121_000);
    expect(vehicle().last_maintenance_mileage).toBe(121_000);
  });

  it("moves the odometer forward with a correction that passes it", async () => {
    const { correct, vehicle } = await finishedAt121k();

    await correct(126_000);

    expect(vehicle().current_mileage).toBe(126_000);
    expect(vehicle().last_maintenance_mileage).toBe(126_000);
  });

  it("leaves a later maintenance alone, and refuses passing the odometer then", async () => {
    const { context, correct, vehicle } = await finishedAt121k();

    // A later maintenance was recorded at 125 000.
    vehicle().last_maintenance_mileage = 125_000;

    await correct(123_000);

    expect(context.orders.serviceOrders[0].new_mileage_after_service).toBe(123_000);
    expect(vehicle().current_mileage).toBe(125_000);
    expect(vehicle().last_maintenance_mileage).toBe(125_000);

    await expect(correct(127_000)).rejects.toMatchObject({
      statusCode: 400,
      code: "SERVICE_ORDER_MILEAGE_AHEAD",
    });

    expect(vehicle().current_mileage).toBe(125_000);
  });

  it("still judges finishing an open order against the odometer", async () => {
    const context = makeContext();

    const open = await context.create.execute(order(), USER);

    context.vehicles.vehicles[0].current_mileage = 125_000;

    await expect(
      context.update.execute(
        { completion_date: new Date("2026-09-22T12:00:00Z"), new_mileage_after_service: 122_000 },
        open.id,
        BUSINESS,
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_ORDER_MILEAGE_BEHIND" });
  });
});

describe("deleting a service order on the twin (FLEET-SO-1)", () => {
  it("refuses a finished order and an order a bill points at", async () => {
    const context = makeContext();

    const finished = await context.create.execute(
      order({
        completion_date: new Date("2026-09-21T12:00:00Z"),
        new_mileage_after_service: 120_500,
      }),
      USER,
    );

    await expect(context.remove.execute(finished.id, BUSINESS, USER)).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_ORDER_COMPLETED",
    });

    const billed = await context.create.execute(order(), USER);
    context.orders.accountsPayable.push({ serviceOrderId: billed.id });

    await expect(context.remove.execute(billed.id, BUSINESS, USER)).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_ORDER_HAS_ACCOUNTS_PAYABLE",
    });

    expect(context.orders.serviceOrders).toHaveLength(2);
  });

  it("deletes an open order with its parts, like the cascade", async () => {
    const context = makeContext();

    const open = await context.create.execute(order(), USER);

    context.orders.parts.push(
      { serviceOrderId: open.id, unit_price: 10, quantity: 1 },
      { serviceOrderId: open.id, unit_price: 20, quantity: 2 },
      { serviceOrderId: "another", unit_price: 5, quantity: 1 },
    );

    const result = await context.remove.execute(open.id, BUSINESS, USER);

    expect(result.partsRemoved).toBe(2);
    expect(context.orders.serviceOrders).toHaveLength(0);
    expect(context.orders.parts).toHaveLength(1);
  });
});

describe("a pin moved by hand in the app (decision 11.3: a code on every refusal)", () => {
  // About 1.1 km apart: one hundredth of a degree of latitude.
  const moved = {
    created_from: "MOBILE_APP" as const,
    location_source: "GPS_MANUAL" as const,
    latitude_original: -23.55,
    longitude_original: -46.63,
    latitude: -23.56,
    longitude: -46.63,
  };

  it("refuses a pin more than 500 m from the GPS reading with LOCATION_ADJUSTMENT_TOO_FAR", async () => {
    const context = makeContext();

    await expect(context.create.execute(order(moved), USER)).rejects.toMatchObject({
      statusCode: 400,
      code: "LOCATION_ADJUSTMENT_TOO_FAR",
    });

    expect(context.orders.serviceOrders).toHaveLength(0);
  });

  it("accepts a pin nudged within 500 m", async () => {
    const context = makeContext();

    await context.create.execute(order({ ...moved, latitude: -23.551 }), USER);

    expect(context.orders.serviceOrders).toHaveLength(1);
  });
});
