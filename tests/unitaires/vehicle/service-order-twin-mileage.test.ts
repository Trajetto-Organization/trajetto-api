import { describe, expect, it, vi } from "vitest";

import { CreateServiceOrderUseCase } from "@/modules/service-order/usecases/create-service-order/create-service-order-usecase";

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
 * The twin of a finished service order, saved with the same key (IDEMP-14 x
 * IDEMP-15 review).
 *
 * A finished order moves the odometer inside its transaction, and only
 * forward: a mileage that is no longer ahead of the vehicle's is refused with
 * a 400. The twin of the same submission — the same form sent again while the
 * first was still in flight — passes the replay check before the first
 * commits, validates against the mileage it read then, and in its transaction
 * meets the odometer the FIRST one just moved. It used to be answered with
 * "a nova quilometragem deve ser maior...", an error for an order that
 * exists; it is the first one's order, like the twin that meets the unique
 * key.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const BRANCH = "018f0000-0000-7000-8000-0000000000b1";

const KEY = "018f0000-0000-4000-8000-00000000ab02";

const outboxStub = { publish: async () => {} } as unknown as OutboxService;

const kanbanStub = {
  createCardFromServiceOrder: () => {},
} as unknown as KanbanService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const business = new InMemoryBusinessRepository();
  const vehicles = new InMemoryVehicleRepository();
  const branches = new InMemoryBranchRepository();
  const orders = new InMemoryServiceOrderRepository();

  users.user.push({
    id: USER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  // With the column defaults (timezone), as the real row has them.
  business.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
  } as unknown as Business);
  branches.branches.push({ id: BRANCH, businessId: BUSINESS } as Branch);

  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    businessId: BUSINESS,
    current_mileage: 120_000,
    maintenance_interval_km: 10_000,
    last_maintenance_mileage: 110_000,
  } as Vehicle);

  return {
    vehicles,
    orders,
    useCase: new CreateServiceOrderUseCase(
      users,
      business,
      vehicles,
      branches,
      new InMemorySupplierRepository(),
      orders,
      outboxStub,
      kanbanStub,
    ),
  };
}

const finishedOrder = (clientSubmissionId?: string) => ({
  date: new Date("2026-09-20"),
  completion_date: new Date("2026-09-21"),
  maintenance_type: "INTERNAL" as const,
  total_amount: 350,
  current_mileage_at_service: 120_000,
  maintenance_interval_km_at_service: 10_000,
  last_maintenance_mileage_at_service: 110_000,
  new_mileage_after_service: 120_300,
  businessId: BUSINESS,
  vehicleId: VEHICLE,
  responsibleUserId: USER,
  branchId: BRANCH,
  created_from: "WEB_DASHBOARD" as const,
  ...(clientSubmissionId && { client_submission_id: clientSubmissionId }),
});

/**
 * Replays the twin's view: the replay check ran before the first order
 * committed, and the vehicle was read before its odometer moved.
 */
function asTheTwinSawIt(context: ReturnType<typeof makeContext>) {
  const find = context.orders.findServiceOrderBySubmissionId.bind(
    context.orders,
  );
  let lookups = 0;

  context.orders.findServiceOrderBySubmissionId = async (...args) => {
    lookups += 1;
    return lookups === 1 ? null : find(...args);
  };

  const read = context.vehicles.findVehicleById.bind(context.vehicles);

  context.vehicles.findVehicleById = async (...args) => {
    const vehicle = await read(...args);
    return vehicle ? { ...vehicle, current_mileage: 120_000 } : null;
  };
}

describe("the twin of a finished service order", () => {
  it("is answered with the first one's order, not with the odometer refusal", async () => {
    const context = makeContext();

    const first = await context.useCase.execute(finishedOrder(KEY), USER);

    expect(context.vehicles.vehicles[0].current_mileage).toBe(120_300);

    asTheTwinSawIt(context);

    const twin = await context.useCase.execute(finishedOrder(KEY), USER);

    expect(twin.id).toBe(first.id);
    expect(context.orders.serviceOrders).toHaveLength(1);
    expect(context.vehicles.vehicles[0].current_mileage).toBe(120_300);
  });

  it("still refuses a mileage behind the odometer when there is no twin", async () => {
    const context = makeContext();

    await context.useCase.execute(finishedOrder(KEY), USER);

    asTheTwinSawIt(context);

    // Another order, another key: nothing to replay, the refusal stands.
    await expect(
      context.useCase.execute(
        finishedOrder("018f0000-0000-4000-8000-00000000ab03"),
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // And without any key at all.
    await expect(
      context.useCase.execute(finishedOrder(), USER),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(context.orders.serviceOrders).toHaveLength(1);
  });
});
