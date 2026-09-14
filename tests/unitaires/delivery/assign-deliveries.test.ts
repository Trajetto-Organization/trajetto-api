import { describe, expect, it } from "vitest";

import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { NotificationService } from "@/shared/services/notification-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryNotAssignableError,
  DeliveryDriverInactiveError,
  DeliveryVehicleUnavailableError,
  DeliveryAssignmentConflictError,
} from "@/modules/delivery/usecases/errors/delivery-errors";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const USER_ID = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";

const VEHICLE_ID = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const driverRepository = new InMemoryDriverRepository();

  const vehicleRepository = new InMemoryVehicleRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  userRepository.user.push({
    id: USER_ID,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  const activityLog: string[] = [];

  const useCase = new AssignDeliveriesUseCase(
    userRepository,
    driverRepository,
    vehicleRepository,
    deliveryRepository,
    {
      createActivityIfEnabled: async (activity: { description: string }) => {
        activityLog.push(activity.description);
      },
    } as unknown as NotificationService,
  );

  return {
    useCase,
    userRepository,
    driverRepository,
    vehicleRepository,
    deliveryRepository,
    activityLog,
  };
}

function seedDriver(
  repository: InMemoryDriverRepository,
  overrides: Partial<Driver> = {},
): Driver {
  const driver = {
    id: DRIVER_ID,
    name: "João Motorista",
    status: "ACTIVE",
    businessId: BUSINESS,
    ...overrides,
  } as Driver;

  repository.drivers.push(driver);
  return driver;
}

function seedVehicle(
  repository: InMemoryVehicleRepository,
  overrides: Partial<Vehicle> = {},
): Vehicle {
  const vehicle = {
    id: VEHICLE_ID,
    license_plate: "ABC1D23",
    status: "ACTIVE",
    businessId: BUSINESS,
    ...overrides,
  } as Vehicle;

  repository.vehicles.push(vehicle);
  return vehicle;
}

async function seedPendingDelivery(
  repository: InMemoryDeliveryRepository,
  overrides: Partial<CreateDeliveryProps> = {},
) {
  return repository.createDelivery({
    recipient_name: "Cliente A",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
    ...overrides,
  } as CreateDeliveryProps);
}

describe("assign deliveries in batch", () => {
  it("assigns a pending batch to an active driver and vehicle", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const first = await seedPendingDelivery(context.deliveryRepository);
    const second = await seedPendingDelivery(context.deliveryRepository, {
      recipient_name: "Cliente B",
    });

    const result = await context.useCase.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryIds: [first.id!, second.id!],
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
    });

    expect(result.assigned).toBe(2);

    for (const delivery of context.deliveryRepository.deliveries) {
      expect(delivery.driverId).toBe(DRIVER_ID);
      expect(delivery.vehicleId).toBe(VEHICLE_ID);
      // Assigning never touches the status machine: "Designada" is the
      // derived reading of PENDING + driver, not a status.
      expect(delivery.status).toBe("PENDING");
    }

    expect(context.activityLog).toHaveLength(1);
    expect(context.activityLog[0]).toContain("2 entregas");
    expect(context.activityLog[0]).toContain("João Motorista");
    expect(context.activityLog[0]).toContain("ABC1D23");
  });

  it("reassignment overwrites the driver and clears an omitted vehicle", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const otherDriverId = "018f0000-0000-7000-8000-0000000000d2";
    seedDriver(context.driverRepository, {
      id: otherDriverId,
      name: "Maria Motorista",
    });

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await context.useCase.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryIds: [delivery.id!],
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
    });

    await context.useCase.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryIds: [delivery.id!],
      driverId: otherDriverId,
    });

    const stored = context.deliveryRepository.deliveries[0];
    expect(stored.driverId).toBe(otherDriverId);

    // Each call fully defines the assignment — the previous vehicle must
    // not linger under the new driver.
    expect(stored.vehicleId).toBeNull();
  });

  it("collapses duplicated ids in the selection", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const result = await context.useCase.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryIds: [delivery.id!, delivery.id!],
      driverId: DRIVER_ID,
    });

    expect(result.assigned).toBe(1);
  });

  it("rejects the whole batch naming deliveries that are not pending", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    const pending = await seedPendingDelivery(context.deliveryRepository);
    const inTransit = await seedPendingDelivery(context.deliveryRepository, {
      recipient_name: "Cliente Em Rota",
    });

    inTransit.status = "IN_TRANSIT";

    await expect(
      context.useCase.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryIds: [pending.id!, inTransit.id!],
        driverId: DRIVER_ID,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("Cliente Em Rota"),
      }),
    );

    // All-or-nothing: the pending delivery in the same batch stays
    // untouched.
    expect(pending.driverId).toBeUndefined();
    expect(context.activityLog).toHaveLength(0);
  });

  it("rejects an inactive driver", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository, { status: "INACTIVE" });

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(
      context.useCase.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryIds: [delivery.id!],
        driverId: DRIVER_ID,
      }),
    ).rejects.toBeInstanceOf(DeliveryDriverInactiveError);
  });

  it("rejects a driver from another business", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository, { businessId: OTHER_BUSINESS });

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(
      context.useCase.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryIds: [delivery.id!],
        driverId: DRIVER_ID,
      }),
    ).rejects.toBeInstanceOf(DriverNotBelongBusinessError);
  });

  it("rejects an unavailable vehicle but accepts one already in route", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    for (const status of ["INACTIVE", "BLOCKED"] as const) {
      context.vehicleRepository.vehicles.length = 0;
      seedVehicle(context.vehicleRepository, { status });

      await expect(
        context.useCase.execute({
          userId: USER_ID,
          businessId: BUSINESS,
          deliveryIds: [delivery.id!],
          driverId: DRIVER_ID,
          vehicleId: VEHICLE_ID,
        }),
      ).rejects.toBeInstanceOf(DeliveryVehicleUnavailableError);
    }

    // IN_ROUTE stays assignable: tomorrow's load is dispatched while
    // today's route is still on the street.
    context.vehicleRepository.vehicles.length = 0;
    seedVehicle(context.vehicleRepository, { status: "IN_ROUTE" });

    const result = await context.useCase.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryIds: [delivery.id!],
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
    });

    expect(result.assigned).toBe(1);
  });

  it("rejects a delivery from another business", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    const foreign = await seedPendingDelivery(context.deliveryRepository, {
      businessId: OTHER_BUSINESS,
    });

    await expect(
      context.useCase.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryIds: [foreign.id!],
        driverId: DRIVER_ID,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotBelongBusinessError);
  });

  it("rejects when a selected delivery does not exist", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    await expect(
      context.useCase.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryIds: ["018f0000-0000-7000-8000-0000000000ff"],
        driverId: DRIVER_ID,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });

  it("refuses a driver token — dispatching belongs to the dispatcher", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    // The permission table opens delivery_manage for the app's own routes;
    // the use case is what keeps a driver from assigning loads to himself.
    const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";

    context.userRepository.user.push({
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User);

    await expect(
      context.useCase.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        deliveryIds: [delivery.id!],
        driverId: DRIVER_ID,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CANNOT_MANAGE_DELIVERIES" });
  });

  it("repository writes nothing when a row left PENDING mid-flight", async () => {
    const repository = new InMemoryDeliveryRepository();

    const pending = await seedPendingDelivery(repository);
    const moved = await seedPendingDelivery(repository, {
      recipient_name: "Cliente Movido",
    });

    // Simulates the race the transaction guards against: a delivery moved
    // between the use case's validation and the repository write.
    moved.status = "IN_TRANSIT";

    await expect(
      repository.assignDeliveries([pending.id!, moved.id!], {
        driverId: DRIVER_ID,
        vehicleId: null,
      }),
    ).rejects.toBeInstanceOf(DeliveryAssignmentConflictError);

    expect(pending.driverId).toBeUndefined();
  });
});
