import { describe, expect, it, vi } from "vitest";

import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import {
  AssignDeliveriesUseCase,
  assignmentMessage,
} from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Batch assignment, which is now a route.
 *
 * It used to be its own writer: it set `Delivery.driverId` and
 * `Delivery.vehicleId` and created nothing else. The architecture plan says
 * those columns are the route's shadow, written only by the route service,
 * and the drift was not the expensive part — a delivery dispatched that way
 * had no route, and the product's evidence hangs off the route. No GPS trail
 * (position recording refuses without a route IN_PROGRESS), nothing on the
 * control tower, no `route.released` for anyone downstream.
 *
 * So the tests here are no longer about columns. They are about what the
 * assignment PRODUCES: a released route, with stops, that a driver can start
 * and that therefore records where the truck went.
 *
 * The real `create-route` and `release-route` are wired in rather than
 * stubbed. A stub would let this file agree with a delegation that never
 * happened, which is precisely the bug it exists to prevent from coming back.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";

const USER_ID = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";

const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000ab";

const VEHICLE_ID = "018f0000-0000-7000-8000-0000000000e1";
const OTHER_VEHICLE_ID = "018f0000-0000-7000-8000-0000000000e2";

const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

function makeContext() {
  const published: Array<{ topic: string }> = [];

  const outboxStub = {
    publish: async (_tx: unknown, event: { topic: string }) => {
      published.push({ topic: event.topic });
    },
  } as unknown as OutboxService;

  const webhookStub = new InMemoryWebhookFanOutService();

  const activityLog: string[] = [];


  const notificationService = {
    createActivityIfEnabled: async (activity: { description: string }) => {
      activityLog.push(activity.description);
    },
  } as unknown as NotificationService;

  const deliveryRepository = new InMemoryDeliveryRepository();

  // One store, shared in both directions: the route repository writes the
  // mirror onto the very rows the delivery repository hands back.
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  userRepository.user.push(
    { id: USER_ID, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER_ID,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
  );

  const createRoute = new CreateRouteUseCase(
    routeRepository,
    userRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    notificationService,
      webhookStub.asService(),
  );

  const releaseRoute = new ReleaseRouteUseCase(
    routeRepository,
    userRepository,
    driverRepository,
    notificationService,
    outboxStub,
    webhookStub.asService(),
  );

  const startRoute = new StartRouteUseCase(
    routeRepository,
    userRepository,
    vehicleRepository,
    notificationService,
    outboxStub,
    webhookStub.asService(),
  );

  const cancelRoute = new CancelRouteUseCase(
    routeRepository,
    userRepository,
    notificationService,
    outboxStub,
    webhookStub.asService(),
  );

  const useCase = new AssignDeliveriesUseCase(
    userRepository,
    routeRepository,
    createRoute,
    releaseRoute,
    cancelRoute,
    new UpdateRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhookStub.asService(),
    ),
  );

  return {
    useCase,
    startRoute,
    routeRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    userRepository,
    activityLog,
    published,
    webhookStub,
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

const assign = (
  context: ReturnType<typeof makeContext>,
  deliveryIds: string[],
  overrides: { driverId?: string; vehicleId?: string | null } = {},
) =>
  context.useCase.execute({
    userId: USER_ID,
    businessId: BUSINESS,
    deliveryIds,
    driverId: overrides.driverId ?? DRIVER_ID,
    vehicleId:
      overrides.vehicleId === undefined ? VEHICLE_ID : overrides.vehicleId,
  });

describe("what an assignment produces", () => {
  it("creates a route with the selection as its stops", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const first = await seedPendingDelivery(context.deliveryRepository);
    const second = await seedPendingDelivery(context.deliveryRepository, {
      recipient_name: "Cliente B",
    });

    const result = await assign(context, [first.id!, second.id!]);

    expect(result.assigned).toBe(2);
    expect(result.routeId).toBeTruthy();

    // The whole point of the change: a route now exists.
    const route = await context.routeRepository.findRouteById(
      result.routeId,
      BUSINESS,
    );

    expect(route, "a designação não criou rota").not.toBeNull();
    expect(route!.stops).toHaveLength(2);
    expect(route!.driverId).toBe(DRIVER_ID);
    expect(route!.vehicleId).toBe(VEHICLE_ID);
  });

  it("releases it, so the driver sees the work immediately", async () => {
    // The shortcut always meant "assign and the driver can see it". A route
    // left PLANNED would have made it stop working.
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const result = await assign(context, [delivery.id!]);

    const route = await context.routeRepository.findRouteById(
      result.routeId,
      BUSINESS,
    );

    expect(route!.status).toBe("RELEASED");
    expect(context.published.map((event) => event.topic)).toContain(
      "route.released",
    );
  });

  it("mirrors the pair onto the deliveries, without touching their status", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await assign(context, [delivery.id!]);

    const stored = context.deliveryRepository.deliveries[0];

    expect(stored.driverId).toBe(DRIVER_ID);
    expect(stored.vehicleId).toBe(VEHICLE_ID);

    // "Designada" is the derived reading of PENDING + driver, not a status.
    // Only the departure moves a delivery to IN_TRANSIT.
    expect(stored.status).toBe("PENDING");
  });

  it("produces a route the driver can actually start", async () => {
    /**
     * This is the assertion the old implementation could never satisfy, and
     * the reason the change was worth making: without a route there is
     * nothing to start, so `record-driver-positions` answered
     * `tracking: false` for the whole day and the trail — the thing a dispute
     * is settled with — did not exist.
     */
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const result = await assign(context, [delivery.id!]);

    await context.startRoute.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      routeId: result.routeId,
    });

    const route = await context.routeRepository.findRouteById(
      result.routeId,
      BUSINESS,
    );

    expect(route!.status).toBe("IN_PROGRESS");
    expect(context.deliveryRepository.deliveries[0].status).toBe("IN_TRANSIT");
  });

  it("tells the integrations, one event per document", async () => {
    /**
     * `delivery.assigned` used to be announced by this use case itself, which
     * meant a subscriber heard about an assignment only when the dispatcher
     * took the shortcut — building the same route on the Rotas screen
     * announced nothing at all. It now comes from `create-route`, so both
     * paths produce it.
     *
     * One per document and not one for the batch: a subscriber matches on a
     * DELIVERY, and an event carrying forty ids is an event every subscriber
     * has to unpack before it can act.
     */
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const first = await seedPendingDelivery(context.deliveryRepository);
    const second = await seedPendingDelivery(context.deliveryRepository, {
      recipient_name: "Cliente B",
    });

    const result = await assign(context, [first.id!, second.id!]);

    const assigned = context.webhookStub.announced.filter(
      (event) => event.topic === "delivery.assigned",
    );

    expect(assigned).toHaveLength(2);

    expect(assigned.map((event) => event.payload.delivery_id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    for (const event of assigned) {
      expect(event.payload.driver_id).toBe(DRIVER_ID);
      expect(event.payload.vehicle_id).toBe(VEHICLE_ID);
      expect(event.payload.route_id).toBe(result.routeId);

      // Inside the creation's own transaction. A loop of events after the
      // commit is not all-or-nothing, and a crash halfway leaves a
      // subscriber's ERP holding twenty of the forty documents that moved.
      expect(event.transactional).toBe(true);
    }
  });

  it("collapses duplicated ids in the selection", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const result = await assign(context, [delivery.id!, delivery.id!]);

    expect(result.assigned).toBe(1);
  });
});

describe("the vehicle is no longer optional", () => {
  it("refuses an assignment with no vehicle, naming why", async () => {
    /**
     * Releasing a route requires a vehicle, for a reason the product already
     * decided: discovering at the truck that none was assigned costs a phone
     * call and a morning. The old shortcut could hand a driver twelve
     * documents and no plate, and nothing anywhere said so.
     */
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(
      assign(context, [delivery.id!], { vehicleId: null }),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_VEHICLE_REQUIRED" });

    // Refused before anything was created.
    expect(context.routeRepository.routes).toHaveLength(0);
    expect(context.deliveryRepository.deliveries[0].driverId).toBeFalsy();
  });
});

describe("a session whose user no longer exists", () => {
  it("is refused as an invalid session, before anything is read or written", async () => {
    // Red before: a bare ResourceNotFoundError, which only the controller's
    // own catch turned into a 400 "Recurso não encontrado!"; that catch is
    // gone, and every route write answers this case with 401.
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(
      context.useCase.execute({
        userId: "018f0000-0000-7000-8000-0000000000ff",
        businessId: BUSINESS,
        deliveryIds: [delivery.id!],
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: "AUTH_SESSION_INVALID" });

    expect(context.routeRepository.routes).toHaveLength(0);
  });
});

describe("what the answer says happened", () => {
  it("names a created, a resent and a re-planned route for what each is", () => {
    // Red before: "criada e liberada" for all three.
    expect(
      assignmentMessage({ outcome: "created", routeCode: 12, assigned: 3 }),
    ).toBe("Rota 12 criada e liberada com 3 entregas.");
    expect(
      assignmentMessage({ outcome: "resent", routeCode: 12, assigned: 1 }),
    ).toBe("Rota 12 já estava criada e liberada com 1 entrega; nada foi alterado.");
    expect(
      assignmentMessage({ outcome: "replanned", routeCode: 12, assigned: 2 }),
    ).toBe("Rota 12 atualizada com o novo planejamento (2 entregas).");
  });

  it("reports the outcome the use case took", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const first = await assign(context, [delivery.id!]);
    const again = await assign(context, [delivery.id!]);

    expect(first.outcome).toBe("created");
    expect(again).toMatchObject({ outcome: "resent", routeId: first.routeId });
  });
});

describe("reassignment", () => {
  it("moves the delivery to the new route while the old one has not left", async () => {
    // An ordinary morning: a driver calls in sick and the documents move.
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedDriver(context.driverRepository, {
      id: OTHER_DRIVER_ID,
      name: "Maria Motorista",
    });

    seedVehicle(context.vehicleRepository);
    seedVehicle(context.vehicleRepository, {
      id: OTHER_VEHICLE_ID,
      license_plate: "XYZ9K87",
    });

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    const first = await assign(context, [delivery.id!]);

    const second = await assign(context, [delivery.id!], {
      driverId: OTHER_DRIVER_ID,
      vehicleId: OTHER_VEHICLE_ID,
    });

    expect(second.routeId).not.toBe(first.routeId);

    const previous = await context.routeRepository.findRouteById(
      first.routeId,
      BUSINESS,
    );

    // A delivery may hold only one open stop at a time, so the first route
    // gives it up rather than keeping a stop nobody will work — and, left with
    // nothing on it, is cancelled instead of staying released (IDEMP-05).
    expect(previous!.stops).toHaveLength(0);
    expect(previous!.status).toBe("CANCELLED");

    const current = await context.routeRepository.findRouteById(
      second.routeId,
      BUSINESS,
    );

    expect(current!.stops).toHaveLength(1);

    const stored = context.deliveryRepository.deliveries[0];

    expect(stored.driverId).toBe(OTHER_DRIVER_ID);
    expect(stored.vehicleId).toBe(OTHER_VEHICLE_ID);
  });

  it("refuses once the route has left, naming the documents", async () => {
    /**
     * The stop is now a record of what the driver is doing. Cancelling it
     * silently to move the document elsewhere would rewrite that record, and
     * the driver would find the delivery gone from the phone mid-street.
     */
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedDriver(context.driverRepository, {
      id: OTHER_DRIVER_ID,
      name: "Maria Motorista",
    });

    seedVehicle(context.vehicleRepository);
    seedVehicle(context.vehicleRepository, {
      id: OTHER_VEHICLE_ID,
      license_plate: "XYZ9K87",
    });

    const delivery = await seedPendingDelivery(context.deliveryRepository, {
      code: "NF-4477",
    });

    const first = await assign(context, [delivery.id!]);

    await context.startRoute.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      routeId: first.routeId,
    });

    await expect(
      assign(context, [delivery.id!], {
        driverId: OTHER_DRIVER_ID,
        vehicleId: OTHER_VEHICLE_ID,
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_ON_STARTED_ROUTE",
      message: expect.stringContaining("NF-4477"),
    });

    // And the route that left keeps its stop.
    const previous = await context.routeRepository.findRouteById(
      first.routeId,
      BUSINESS,
    );

    expect(previous!.stops).toHaveLength(1);
  });
});

describe("what the route path refuses on the assignment's behalf", () => {
  it("refuses an inactive driver", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository, { status: "INACTIVE" });
    seedVehicle(context.vehicleRepository);

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(assign(context, [delivery.id!])).rejects.toMatchObject({
      code: "ROUTE_DRIVER_INACTIVE",
    });
  });

  it("refuses a vehicle that is out of operation", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository, { status: "BLOCKED" });

    const delivery = await seedPendingDelivery(context.deliveryRepository);

    await expect(assign(context, [delivery.id!])).rejects.toMatchObject({
      code: "ROUTE_VEHICLE_UNAVAILABLE",
    });
  });

  it("refuses the whole batch naming deliveries that are not pending", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const pending = await seedPendingDelivery(context.deliveryRepository);
    const inTransit = await seedPendingDelivery(context.deliveryRepository, {
      recipient_name: "Cliente Em Rota",
    });

    inTransit.status = "IN_TRANSIT";

    await expect(
      assign(context, [pending.id!, inTransit.id!]),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Cliente Em Rota"),
    });

    // All-or-nothing: the pending delivery in the same batch stays untouched
    // and no route was created for half of it.
    expect(pending.driverId).toBeFalsy();
    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("refuses a delivery of another company", async () => {
    const context = makeContext();
    seedDriver(context.driverRepository);
    seedVehicle(context.vehicleRepository);

    const foreign = await seedPendingDelivery(context.deliveryRepository, {
      businessId: "018f0000-0000-7000-8000-00000000000c",
    });

    // The same answer as an id that does not exist: a 403 here told the
    // caller the id was real, someone else's.
    await expect(assign(context, [foreign.id!])).rejects.toMatchObject({
      statusCode: 404,
      code: "DELIVERY_NOT_FOUND",
    });
  });
});
