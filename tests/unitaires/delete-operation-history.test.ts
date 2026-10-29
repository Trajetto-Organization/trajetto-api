import { beforeEach, describe, expect, it } from "vitest";

import { DeleteDriverUseCase } from "@/modules/driver/usecases/delete-driver/delete-driver-usecase";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import type { NotificationService } from "@/shared/services/notification-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

/**
 * What a hard delete would take with it, refused before it takes it.
 *
 * The delete use cases already refused a driver with fines, fuel records or
 * checklists — each with a named count. Deliveries and routes were never on
 * that list, and the schema makes that omission silent rather than loud:
 * `Delivery.driver` is an optional relation, so Postgres NULLs it and the
 * delete SUCCEEDS. A delivery that is DELIVERED, with a delivered_at, and
 * nobody who delivered it.
 *
 * `tests/E2E/delete-cascade-integrity` proves that is really what the database
 * does. This file proves the product no longer lets anyone ask for it.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const notificationStub = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const businessRepository = new InMemoryBusinessRepository();

  const driverRepository = new InMemoryDriverRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository();

  userRepository.user.push({
    id: ADMIN,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businessRepository.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    corporate_reason: "Transportadora",
  } as Business);

  driverRepository.drivers.push({
    id: DRIVER,
    name: "João",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  return {
    driverRepository,
    deliveryRepository,
    routeRepository,

    deleteDriver: new DeleteDriverUseCase(
      userRepository,
      businessRepository,
      driverRepository,
      new InMemoryFineRepository(),
      new InMemoryFuelRepository(),
      new InMemoryVehicleChecklistRepository(),
      deliveryRepository,
      routeRepository,
      notificationStub,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(
  overrides: Partial<CreateDeliveryProps> & { driverId?: string } = {},
) {
  const { driverId, ...rest } = overrides;

  const created = await context.deliveryRepository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatário",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...rest,
  } as CreateDeliveryProps);

  if (driverId) created.driverId = driverId;

  return created;
}

describe("deleting a driver who worked", () => {
  it("is refused when they made a delivery, and says how many", async () => {
    const delivered = await seedDelivery({ driverId: DRIVER });

    delivered.status = "DELIVERED";

    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).rejects.toThrow(/1 entrega/);

    // Still there. Without the guard the driver would be gone and this
    // delivery would read DELIVERED with nobody who delivered it.
    expect(context.driverRepository.drivers).toHaveLength(1);
    expect(delivered.driverId).toBe(DRIVER);
  });

  it("is refused when they have a route", async () => {
    await context.routeRepository.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [],
    });

    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).rejects.toThrow(/1 rota/);

    expect(context.driverRepository.drivers).toHaveLength(1);
  });

  it("names both when there are both", async () => {
    const delivery = await seedDelivery({ driverId: DRIVER });

    delivery.status = "DELIVERED";

    await context.routeRepository.createRoute({
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [],
    });

    // The operator fixes what is in the way; they need the whole list, not
    // the first thing the code happened to check.
    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).rejects.toThrow(/1 entrega\(s\) e 1 rota\(s\)/);
  });

  it("points at deactivation, which is what the operator actually wants", async () => {
    // A driver who left the company should stop appearing in every picker and
    // stop being able to log in. That is what INACTIVE does, and it keeps the
    // history — which is the whole reason the delete is refused.
    await seedDelivery({ driverId: DRIVER });

    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).rejects.toThrow(/Inativar o motorista/);
  });

  it("counts the work of any status, not only what is running", async () => {
    // A completed route and a delivered delivery are precisely what deleting
    // the driver would erase. Counting only open work would let the history
    // be deleted the day after it was made.
    const cancelled = await seedDelivery({ driverId: DRIVER });

    cancelled.status = "CANCELLED";

    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).rejects.toThrow(/1 entrega/);
  });
});

describe("deleting a driver who never worked", () => {
  it("goes through", async () => {
    // The guard is about history, not about existing. A driver registered by
    // mistake this morning has none and can be removed.
    const deleted = await context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS);

    expect(deleted.id).toBe(DRIVER);
    expect(context.driverRepository.drivers).toHaveLength(0);
  });

  it("is not blocked by somebody else's work", async () => {
    const other = "018f0000-0000-7000-8000-0000000000d9";

    const theirs = await seedDelivery({ driverId: other });

    theirs.status = "DELIVERED";

    await context.routeRepository.createRoute({
      businessId: BUSINESS,
      driverId: other,
      scheduled_date: new Date(),
      deliveryIds: [],
    });

    await expect(
      context.deleteDriver.execute(DRIVER, ADMIN, BUSINESS),
    ).resolves.toBeDefined();
  });
});
