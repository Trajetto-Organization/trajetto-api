import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { deliveryAssignedPayload } from "@/shared/integration/announce";
import { WEBHOOK_PAYLOAD_SCHEMAS } from "@/shared/integration/webhook-payload-schemas";

import type { NotificationService } from "@/shared/services/notification-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * `delivery.assigned` is published as "a delivery gained a driver", and only
 * the route builder ever said it. Adding stops to a route that already has a
 * driver, and swapping the driver (or the vehicle) of a route that has not
 * left, both put deliveries in somebody's hands without a word to the ERP
 * subscribed to exactly that — it kept telling its customer the old driver
 * was coming, or nobody.
 */
const A = "018f0000-0000-7000-8000-00000000030a";

const DISPATCHER = "018f0000-0000-7000-8000-0000000003a1";

const DRIVER_JOAO = "018f0000-0000-7000-8000-0000000003d1";
const DRIVER_MARIA = "018f0000-0000-7000-8000-0000000003d2";

const VEHICLE_ONE = "018f0000-0000-7000-8000-0000000003e1";
const VEHICLE_TWO = "018f0000-0000-7000-8000-0000000003e2";

const SHIPPER = "018f0000-0000-7000-8000-0000000003f1";
const TODAY = new Date("2026-09-15T08:00:00.000Z");

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function makeContext() {
  const webhooks = new InMemoryWebhookFanOutService();

  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  userRepository.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: A,
  } as User);

  driverRepository.drivers.push(
    {
      id: DRIVER_JOAO,
      name: "João",
      status: "ACTIVE",
      businessId: A,
    } as Driver,
    {
      id: DRIVER_MARIA,
      name: "Maria",
      status: "ACTIVE",
      businessId: A,
    } as Driver,
  );

  vehicleRepository.vehicles.push(
    {
      id: VEHICLE_ONE,
      license_plate: "AAA1A11",
      status: "ACTIVE",
      businessId: A,
    } as Vehicle,
    {
      id: VEHICLE_TWO,
      license_plate: "BBB2B22",
      status: "ACTIVE",
      businessId: A,
    } as Vehicle,
  );

  return {
    webhooks,
    deliveryRepository,
    routeRepository,

    create: new CreateRouteUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),

    addStops: new AddRouteStopsUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      notificationService,
      webhooks.asService(),
    ),

    update: new UpdateRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(code: string) {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    code,
    invoice_key: `3524061234567800019955001000001234100001${code.padStart(4, "0")}`,
    recipient_name: `Cliente ${code}`,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function plannedRoute(deliveryIds: string[]) {
  const route = await context.create.execute({
    userId: DISPATCHER,
    businessId: A,
    driverId: DRIVER_JOAO,
    vehicleId: VEHICLE_ONE,
    scheduled_date: TODAY,
    deliveryIds,
  });

  // Only what the call under test announces.
  context.webhooks.reset();

  return route;
}

describe("adding stops to a route that has a driver", () => {
  it("announces each new delivery as assigned, inside the write's transaction", async () => {
    const route = await plannedRoute([await seedDelivery("1")]);

    const added = [await seedDelivery("2"), await seedDelivery("3")];

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: added,
    });

    const assigned = context.webhooks.forTopic("delivery.assigned");

    expect(assigned.map((event) => event.payload.delivery_id).sort()).toEqual(
      [...added].sort(),
    );

    for (const event of assigned) {
      expect(event.businessId).toBe(A);
      expect(event.transactional).toBe(true);

      expect(event.payload).toMatchObject({
        driver_id: DRIVER_JOAO,
        vehicle_id: VEHICLE_ONE,
        route_id: route.id,
        route_code: route.code,
      });

      // The three identifiers every document event carries.
      expect(event.payload.code).toMatch(/^[23]$/);
      expect(event.payload.invoice_key).toMatch(/^\d{44}$/);
    }
  });
});

describe("editing a route that has not left", () => {
  it("announces every open stop again when the driver changes", async () => {
    const stops = [await seedDelivery("4"), await seedDelivery("5")];
    const route = await plannedRoute(stops);

    await context.update.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      driverId: DRIVER_MARIA,
    });

    const assigned = context.webhooks.forTopic("delivery.assigned");

    expect(assigned.map((event) => event.payload.delivery_id).sort()).toEqual(
      [...stops].sort(),
    );

    for (const event of assigned) {
      expect(event.transactional).toBe(true);
      expect(event.payload).toMatchObject({
        driver_id: DRIVER_MARIA,
        vehicle_id: VEHICLE_ONE,
        route_id: route.id,
      });
    }
  });

  it("announces them when only the vehicle changes", async () => {
    const stops = [await seedDelivery("6")];
    const route = await plannedRoute(stops);

    await context.update.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      vehicleId: VEHICLE_TWO,
    });

    const assigned = context.webhooks.forTopic("delivery.assigned");

    expect(assigned).toHaveLength(1);
    expect(assigned[0].payload).toMatchObject({
      driver_id: DRIVER_JOAO,
      vehicle_id: VEHICLE_TWO,
    });
  });

  it("publishes the shape the public reference documents", () => {
    const payload = deliveryAssignedPayload(
      { id: "d1", code: "1" },
      { id: "r1", code: 7, driverId: DRIVER_JOAO, vehicleId: null },
    );

    const documented = WEBHOOK_PAYLOAD_SCHEMAS.WebhookAssignmentData
      .properties as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(Object.keys(documented).sort());
  });

  it("stays quiet when neither the driver nor the vehicle changes", async () => {
    const route = await plannedRoute([await seedDelivery("7")]);

    await context.update.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      name: "Rota da manhã",
      driverId: DRIVER_JOAO,
      vehicleId: VEHICLE_ONE,
    });

    expect(context.webhooks.forTopic("delivery.assigned")).toHaveLength(0);
  });
});
