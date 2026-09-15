import { describe, expect, it, vi } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";
import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";
import { DeliveryVehicleUnavailableError } from "@/modules/delivery/usecases/errors/delivery-errors";

import {
  tallyStatuses,
  isVehicleOutOfOperation,
} from "@/shared/vehicle/vehicle-rules";

import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

// The use cases now wrap their write and the webhook they announce in one
// transaction. Against in-memory repositories the transaction is a plain
// passthrough — what it proves here is that the event is queued in the same
// unit of work, not that Postgres rolled anything back.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));


// Nothing here asserts on webhooks; the use cases simply require one.
const webhookStub = new InMemoryWebhookFanOutService();

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

const GOOD_VEHICLE = "018f0000-0000-7000-8000-0000000000c1";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;
const BAD_VEHICLE = "018f0000-0000-7000-8000-0000000000c2";

function seedVehicle(
  repository: InMemoryVehicleRepository,
  overrides: Partial<Vehicle> = {},
): Vehicle {
  const vehicle = {
    id: GOOD_VEHICLE,
    description: "Caminhão",
    license_plate: "ABC1D23",
    brand: "Volvo",
    model: "FH",
    renavam: "1",
    status: "ACTIVE",
    businessId: BUSINESS,
    ...overrides,
  } as Vehicle;

  repository.vehicles.push(vehicle);
  return vehicle;
}

describe("vehicle status tally", () => {
  it("fills the statuses that have no rows instead of leaving them undefined", () => {
    // A fleet with nothing blocked produces no BLOCKED group at all; the card
    // has to read 0, not undefined.
    const counts = tallyStatuses([{ status: "ACTIVE", _count: { _all: 7 } }]);

    expect(counts).toEqual({
      ACTIVE: 7,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });
  });

  it("counts the whole fleet, not the page on screen", async () => {
    const repository = new InMemoryVehicleRepository();

    // Forty active vehicles, ten to a page: the cards used to filter the page
    // array and report "10 (25%)" for a fleet that is 100% active.
    for (let index = 0; index < 40; index += 1) {
      seedVehicle(repository, {
        id: `018f0000-0000-7000-8000-0000000${index.toString().padStart(5, "0")}`,
        license_plate: `ABC1D${index.toString().padStart(2, "0")}`,
        renavam: String(index),
      });
    }

    const listed = await repository.listVehicles({
      page: 1,
      pageSize: 10,
      businessId: BUSINESS,
    });

    expect(listed.data).toHaveLength(10);
    expect(listed.total).toBe(40);
    expect(listed.meta.statusCounts.ACTIVE).toBe(40);
  });

  it("keeps the four counts adding up to the total under a search filter", async () => {
    const repository = new InMemoryVehicleRepository();

    seedVehicle(repository, { id: "v1", license_plate: "AAA1A11", renavam: "1" });
    seedVehicle(repository, {
      id: "v2",
      license_plate: "AAA2A22",
      renavam: "2",
      status: "BLOCKED",
    });
    seedVehicle(repository, {
      id: "v3",
      license_plate: "ZZZ9Z99",
      renavam: "3",
      status: "INACTIVE",
    });

    const listed = await repository.listVehicles({
      page: 1,
      pageSize: 10,
      businessId: BUSINESS,
      search: "AAA",
    });

    const { ACTIVE, INACTIVE, BLOCKED, IN_ROUTE } = listed.meta.statusCounts;

    expect(ACTIVE + INACTIVE + BLOCKED + IN_ROUTE).toBe(listed.total);
    expect(listed.total).toBe(2);
  });

  it("does not treat a vehicle already on the street as out of operation", () => {
    expect(isVehicleOutOfOperation("IN_ROUTE")).toBe(false);
    expect(isVehicleOutOfOperation("ACTIVE")).toBe(false);
    expect(isVehicleOutOfOperation("INACTIVE")).toBe(true);
    expect(isVehicleOutOfOperation("BLOCKED")).toBe(true);
  });
});

describe("a vehicle out of operation cannot take new cargo", () => {
  function makeContext() {
    const userRepository = new InMemoryUserRepository();
    const shipperRepository = new InMemoryShipperRepository();
    const vehicleRepository = new InMemoryVehicleRepository();
    const driverRepository = new InMemoryDriverRepository();
    const deliveryRepository = new InMemoryDeliveryRepository();

    userRepository.user.push({
      id: USER_ID,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User);

    shipperRepository.shippers.push({
      id: SHIPPER_ID,
      name: "Embarcador",
      businessId: BUSINESS,
    } as Shipper);

    seedVehicle(vehicleRepository);
    seedVehicle(vehicleRepository, {
      id: BAD_VEHICLE,
      license_plate: "XYZ9W88",
      renavam: "999",
      status: "BLOCKED",
    });

    const businessRepository = new InMemoryBusinessRepository();
    businessRepository.business.push({
      id: BUSINESS,
      corporate_reason: "Transportes Teste",
    } as Business);

    const updateDelivery = new UpdateDeliveryUseCase(
      userRepository,
      shipperRepository,
      vehicleRepository,
      driverRepository,
      deliveryRepository,
    );

    const createDelivery = new CreateDeliveryUseCase(
      userRepository,
      businessRepository,
      shipperRepository,
      vehicleRepository,
      driverRepository,
      deliveryRepository,
      notificationStub,
      webhookStub.asService(),
    );

    return {
      deliveryRepository,
      vehicleRepository,
      updateDelivery,
      createDelivery,
    };
  }

  async function seedDelivery(
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

  it("refuses to attach a blocked vehicle at creation", async () => {
    const context = makeContext();

    await expect(
      context.createDelivery.execute(
        {
          recipient_name: "Cliente A",
          city: "São Paulo",
          uf: "SP",
          street: "Rua Um",
          businessId: BUSINESS,
          shipperId: SHIPPER_ID,
          vehicleId: BAD_VEHICLE,
        } as CreateDeliveryProps,
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(DeliveryVehicleUnavailableError);
  });

  it("refuses to attach a blocked vehicle on edit", async () => {
    const context = makeContext();
    const delivery = await seedDelivery(context.deliveryRepository);

    await expect(
      context.updateDelivery.execute({
        userId: USER_ID,
        businessId: BUSINESS,
        deliveryId: delivery.id!,
        deliveryData: { vehicleId: BAD_VEHICLE },
      }),
    ).rejects.toBeInstanceOf(DeliveryVehicleUnavailableError);
  });

  it("still lets an unrelated field be corrected on a load whose vehicle went out of operation", async () => {
    const context = makeContext();

    const delivery = await seedDelivery(context.deliveryRepository, {
      vehicleId: GOOD_VEHICLE,
    });

    // The vehicle is blocked AFTER the load was already attached to it, which
    // is exactly when someone needs to fix the address. Refusing every save
    // would trap the record.
    context.vehicleRepository.vehicles[0].status = "BLOCKED";

    const updated = await context.updateDelivery.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      deliveryData: { vehicleId: GOOD_VEHICLE, street: "Rua Dois" },
    });

    expect(updated.street).toBe("Rua Dois");
  });
});
