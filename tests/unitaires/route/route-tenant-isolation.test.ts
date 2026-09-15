import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Releasing and cancelling wrap the route write and its outbox event in one
 * database transaction — the driver's push must exist if and only if the write
 * landed. Against in-memory repositories the transaction is a passthrough.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * Two carriers on one installation, and every way one could reach the other.
 *
 * The route module carries the tenant in two places on purpose: the use case
 * checks it, and every `where` that touches a route carries it too. That is
 * not belt and braces for its own sake — the use case protects the path
 * somebody remembered, and the `where` protects the paths nobody thought
 * about: a controller wired straight to the repository, a background job, the
 * spreadsheet importer of the next slice, a script run at 2am.
 *
 * So this file exercises BOTH layers. The use-case tests prove the product
 * refuses; the repository tests prove it would still refuse if a future caller
 * skipped the use case entirely.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DISPATCHER_A = "018f0000-0000-7000-8000-0000000000a1";
const DISPATCHER_B = "018f0000-0000-7000-8000-0000000000b1";
const DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_USER_B = "018f0000-0000-7000-8000-0000000000b2";

const DRIVER_A = "018f0000-0000-7000-8000-0000000000d1";
const DRIVER_B = "018f0000-0000-7000-8000-0000000000d2";

const VEHICLE_A = "018f0000-0000-7000-8000-0000000000e1";
const VEHICLE_B = "018f0000-0000-7000-8000-0000000000e2";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const TOMORROW = new Date("2026-09-16T08:00:00.000Z");

const outboxStub = {
  publish: async () => undefined,
} as unknown as OutboxService;

function makeContext() {
  const routeRepository = new InMemoryRouteRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();

  const userRepository = new InMemoryUserRepository();

  userRepository.user.push(
    { id: DISPATCHER_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: DISPATCHER_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    {
      id: DRIVER_USER_A,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_A,
    } as User,
    {
      id: DRIVER_USER_B,
      role: "BUSINESS_USER",
      businessId: B,
      driverId: DRIVER_B,
    } as User,
  );

  driverRepository.drivers.push(
    { id: DRIVER_A, name: "João (A)", status: "ACTIVE", businessId: A } as Driver,
    { id: DRIVER_B, name: "Maria (B)", status: "ACTIVE", businessId: B } as Driver,
  );

  vehicleRepository.vehicles.push(
    {
      id: VEHICLE_A,
      license_plate: "AAA1A11",
      status: "ACTIVE",
      businessId: A,
    } as Vehicle,
    {
      id: VEHICLE_B,
      license_plate: "BBB2B22",
      status: "ACTIVE",
      businessId: B,
    } as Vehicle,
  );

  const notificationService = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  return {
    routeRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    userRepository,

    create: new CreateRouteUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
    ),
    release: new ReleaseRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      notificationService,
      outboxStub,
    ),
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
      outboxStub,
    ),
    cancel: new CancelRouteUseCase(
      routeRepository,
      userRepository,
      notificationService,
      outboxStub,
    ),
    update: new UpdateRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

async function seedDelivery(businessId: string): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId,
    shipperId: SHIPPER,
    recipient_name: "Destinatário",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  context.routeRepository.deliveries.push({
    id: created.id!,
    businessId,
    driverId: null,
    vehicleId: null,
    status: created.status,
    recipient_name: created.recipient_name,
  });

  return created.id!;
}

/** A route of carrier A, planned with one of A's deliveries. */
async function routeOfA(): Promise<{ id: string; deliveryId: string }> {
  const deliveryId = await seedDelivery(A);

  const route = await context.create.execute({
    userId: DISPATCHER_A,
    businessId: A,
    driverId: DRIVER_A,
    vehicleId: VEHICLE_A,
    scheduled_date: TOMORROW,
    deliveryIds: [deliveryId],
  });

  return { id: route.id, deliveryId };
}

beforeEach(() => {
  context = makeContext();
});

describe("creating a route with someone else's resources", () => {
  it("refuses a driver of the other carrier", async () => {
    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_B,
        scheduled_date: TOMORROW,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DRIVER_NOT_FOUND" });

    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("refuses a vehicle of the other carrier", async () => {
    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        vehicleId: VEHICLE_B,
        scheduled_date: TOMORROW,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VEHICLE_NOT_FOUND" });

    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("refuses a delivery of the other carrier", async () => {
    const foreignDelivery = await seedDelivery(B);

    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        vehicleId: VEHICLE_A,
        scheduled_date: TOMORROW,
        deliveryIds: [foreignDelivery],
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_BELONG_BUSINESS" });

    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("refuses the whole batch when only one delivery is foreign", async () => {
    // All-or-nothing: a partially built route would have to be found and
    // undone by hand, and the dispatcher has no way to know which half landed.
    const mine = await seedDelivery(A);
    const theirs = await seedDelivery(B);

    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        vehicleId: VEHICLE_A,
        scheduled_date: TOMORROW,
        deliveryIds: [mine, theirs],
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_BELONG_BUSINESS" });

    expect(context.routeRepository.routes).toHaveLength(0);
    expect(context.routeRepository.stops).toHaveLength(0);

    const untouched = context.routeRepository.deliveries.find(
      (entry) => entry.id === mine,
    );

    expect(untouched?.driverId).toBeNull();
  });
});

describe("acting on the other carrier's route", () => {
  it("cannot be released", async () => {
    const route = await routeOfA();

    await expect(
      context.release.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(context.routeRepository.routes[0].status).toBe("PLANNED");
  });

  it("cannot be cancelled", async () => {
    const route = await routeOfA();

    await expect(
      context.cancel.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
        reason: "sabotagem",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(context.routeRepository.routes[0].status).toBe("PLANNED");
    expect(context.routeRepository.routes[0].cancellation_reason).toBeNull();
  });

  it("cannot be edited", async () => {
    const route = await routeOfA();

    await expect(
      context.update.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
        name: "sequestrada",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(context.routeRepository.routes[0].name).toBeNull();
  });

  it("cannot have its driver swapped for one of the other carrier", async () => {
    // The nastiest shape of the attack: a valid route id of A, edited by A's
    // own dispatcher, pointing at a driver of B. It would put B's driver on
    // A's deliveries — and B's screens would show them.
    const route = await routeOfA();

    await expect(
      context.update.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        driverId: DRIVER_B,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DRIVER_NOT_FOUND" });

    expect(context.routeRepository.routes[0].driverId).toBe(DRIVER_A);
  });

  it("cannot have its vehicle swapped for one of the other carrier", async () => {
    const route = await routeOfA();

    await expect(
      context.update.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        vehicleId: VEHICLE_B,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VEHICLE_NOT_FOUND" });

    expect(context.routeRepository.routes[0].vehicleId).toBe(VEHICLE_A);
  });

  it("cannot be started by a driver of the other carrier", async () => {
    const route = await routeOfA();

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    await expect(
      context.start.execute({
        userId: DRIVER_USER_B,
        businessId: B,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(context.routeRepository.routes[0].status).toBe("RELEASED");
    expect(context.routeRepository.routes[0].started_at).toBeNull();
  });

  it("is invisible in the other carrier's listing", async () => {
    await routeOfA();

    const listing = await context.routeRepository.listRoutes({
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(listing.data).toHaveLength(0);
    expect(listing.total).toBe(0);
    expect(listing.meta.statusCounts.PLANNED).toBe(0);
  });

  it("is invisible when looking up the driver's route", async () => {
    const route = await routeOfA();

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    // Same driver id, wrong carrier: nothing.
    expect(
      await context.routeRepository.findDriverRoute(B, DRIVER_A),
    ).toBeNull();
  });
});

describe("the repository refuses on its own, without the use case", () => {
  /**
   * These call the repository directly, the way a future controller, job or
   * import script might. If the tenant guard lived only in the use case, every
   * one of them would succeed.
   */
  it("does not find the route", async () => {
    const route = await routeOfA();

    expect(await context.routeRepository.findRouteById(route.id, B)).toBeNull();
    expect(
      await context.routeRepository.findRouteById(route.id, A),
    ).not.toBeNull();
  });

  it("does not transition it", async () => {
    const route = await routeOfA();

    await expect(
      context.routeRepository.transitionRoute(route.id, B, {
        expectedStatus: "PLANNED",
        status: "RELEASED",
      }),
    ).rejects.toThrow();

    expect(context.routeRepository.routes[0].status).toBe("PLANNED");
  });

  it("does not update its fields", async () => {
    // updateRoute was the gap: it reached the row by id alone, and no use case
    // called it — so nothing would have caught a future caller that did.
    const route = await routeOfA();

    await expect(
      context.routeRepository.updateRoute(route.id, B, { name: "sequestrada" }),
    ).rejects.toThrow();

    expect(context.routeRepository.routes[0].name).toBeNull();
  });

  it("does not add stops to it", async () => {
    const route = await routeOfA();
    const foreignDelivery = await seedDelivery(B);

    await expect(
      context.routeRepository.addStops(route.id, B, [foreignDelivery]),
    ).rejects.toThrow();

    expect(context.routeRepository.stops).toHaveLength(1);
  });

  it("does not remove its stops", async () => {
    const route = await routeOfA();
    const stopId = context.routeRepository.stops[0].id;

    await expect(
      context.routeRepository.removeStop(route.id, B, stopId),
    ).rejects.toThrow();

    expect(context.routeRepository.stops).toHaveLength(1);
  });

  it("does not reorder its stops", async () => {
    const route = await routeOfA();
    const stopId = context.routeRepository.stops[0].id;

    await expect(
      context.routeRepository.reorderStops(route.id, B, [stopId]),
    ).rejects.toThrow();
  });

  it("does not settle its stops", async () => {
    const route = await routeOfA();

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId: route.id,
    });

    const deliveryId = context.routeRepository.stops[0].deliveryId;

    // Settling answers null rather than throwing, because most deliveries are
    // not on a route and a refusal must not sink the delivery outcome that
    // triggered it. So the assertion that carries weight is the second one:
    // the stop is untouched. A `where` that matched nothing wrote nothing.
    expect(
      await context.routeRepository.settleStopForDelivery(deliveryId, B, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).toBeNull();

    expect(context.routeRepository.stops[0].status).toBe("PENDING");
    expect(context.routeRepository.stops[0].completed_at).toBeNull();

    // And the same call from the right carrier does work — otherwise the null
    // above would prove nothing but a typo.
    expect(
      await context.routeRepository.settleStopForDelivery(deliveryId, A, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).not.toBeNull();
  });

  it("does not find a stop through the wrong carrier", async () => {
    const route = await routeOfA();
    const stopId = context.routeRepository.stops[0].id;

    expect(await context.routeRepository.findStopById(stopId, B)).toBeNull();
    expect(await context.routeRepository.findStopById(stopId, A)).not.toBeNull();

    // Referenced so the helper's route id is not unused, and to pin that the
    // stop really does belong to the route under test.
    expect(context.routeRepository.stops[0].routeId).toBe(route.id);
  });
});

describe("the mirror never crosses the line", () => {
  it("leaves the other carrier's delivery untouched", async () => {
    // Delivery.driverId is written by the route service. If that write were
    // not scoped, a crafted id would let carrier A stamp its driver onto a
    // delivery of carrier B — visible on B's own screens.
    const foreign = await seedDelivery(B);
    const route = await routeOfA();

    await context.routeRepository.addStops(route.id, A, [foreign]).catch(
      () => undefined,
    );

    const untouched = context.routeRepository.deliveries.find(
      (entry) => entry.id === foreign,
    );

    expect(untouched?.driverId).toBeNull();
    expect(untouched?.vehicleId).toBeNull();
  });
});
