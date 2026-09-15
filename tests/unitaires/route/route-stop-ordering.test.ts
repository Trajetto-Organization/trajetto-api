import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";

import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { RemoveRouteStopUseCase } from "@/modules/route/usecases/remove-route-stop/remove-route-stop-usecase";
import { ReorderRouteStopsUseCase } from "@/modules/route/usecases/reorder-route-stops/reorder-route-stops-usecase";

import { GetRouteUseCase } from "@/modules/route/usecases/get-route/get-route-usecase";
import { ListRoutesUseCase } from "@/modules/route/usecases/list-routes/list-routes-usecase";

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
 * The order of the stops is the order the driver works the street in, and
 * dispatchers change it by dragging — often while a colleague is changing
 * something else on the same route.
 *
 * So reordering takes the COMPLETE list rather than "move stop X to position
 * 3". A move instruction applied to a route that has since changed silently
 * produces an order nobody asked for; a full list either describes the route
 * as it is, or describes a route that no longer exists — and the second is
 * refused rather than guessed at.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DISPATCHER_A = "018f0000-0000-7000-8000-0000000000a1";
const DISPATCHER_B = "018f0000-0000-7000-8000-0000000000b1";
const DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a2";

const DRIVER_A = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE_A = "018f0000-0000-7000-8000-0000000000e1";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const TODAY = new Date("2026-09-15T08:00:00.000Z");

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

const outboxStub = {
  publish: async () => undefined,
} as unknown as OutboxService;

function makeContext() {
  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

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
  );

  driverRepository.drivers.push({
    id: DRIVER_A,
    name: "João",
    status: "ACTIVE",
    businessId: A,
  } as Driver);

  vehicleRepository.vehicles.push({
    id: VEHICLE_A,
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: A,
  } as Vehicle);

  return {
    routeRepository,
    deliveryRepository,

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

    addStops: new AddRouteStopsUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      notificationService,
    ),
    removeStop: new RemoveRouteStopUseCase(routeRepository, userRepository, notificationService),
    reorder: new ReorderRouteStopsUseCase(routeRepository, userRepository, notificationService),

    get: new GetRouteUseCase(routeRepository, userRepository),
    list: new ListRoutesUseCase(routeRepository, userRepository),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(businessId = A, name = "Destinatário") {
  const created = await context.deliveryRepository.createDelivery({
    businessId,
    shipperId: SHIPPER,
    recipient_name: name,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function plannedRoute(deliveryIds: string[]) {
  return context.create.execute({
    userId: DISPATCHER_A,
    businessId: A,
    driverId: DRIVER_A,
    vehicleId: VEHICLE_A,
    scheduled_date: TODAY,
    deliveryIds,
  });
}

/** Stop ids in the order the driver would work them. */
function orderOf(routeId: string): string[] {
  return context.routeRepository.stops
    .filter((stop) => stop.routeId === routeId)
    .sort((left, right) => left.sequence - right.sequence)
    .map((stop) => stop.id);
}

function sequencesOf(routeId: string): number[] {
  return context.routeRepository.stops
    .filter((stop) => stop.routeId === routeId)
    .map((stop) => stop.sequence)
    .sort((left, right) => left - right);
}

describe("adding stops to a route", () => {
  it("appends at the end, spaced so a later insert is cheap", async () => {
    const route = await plannedRoute([await seedDelivery()]);
    const extra = await seedDelivery(A, "Cliente novo");

    const created = await context.addStops.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      deliveryIds: [extra],
    });

    expect(created).toHaveLength(1);

    // Spaced by ten: dropping a stop between two others later rewrites two
    // rows instead of every row after it.
    expect(sequencesOf(route.id)).toEqual([10, 20]);
    expect(orderOf(route.id)[1]).toBe(created[0].id);
  });

  it("mirrors the route's driver onto the new stop's delivery", async () => {
    const route = await plannedRoute([]);
    const delivery = await seedDelivery();

    await context.addStops.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      deliveryIds: [delivery],
    });

    const row = context.deliveryRepository.deliveries.find(
      (entry) => entry.id === delivery,
    )!;

    expect(row.driverId).toBe(DRIVER_A);
    expect(row.vehicleId).toBe(VEHICLE_A);
  });

  it("refuses an empty selection instead of doing nothing quietly", async () => {
    const route = await plannedRoute([]);

    await expect(
      context.addStops.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        deliveryIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_STOPS_REQUIRED" });
  });

  it("refuses a delivery that is already a stop on this very route", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    await expect(
      context.addStops.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        deliveryIds: [delivery],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ALREADY_ON_ROUTE",
      // The partial unique index would refuse this too, with the same code —
      // but its message says "já está em OUTRA rota", which is false here and
      // sends the dispatcher looking for a route that does not exist. The
      // check above it exists for this sentence.
      message: expect.stringContaining("já está nesta rota"),
    });

    expect(orderOf(route.id)).toHaveLength(1);
  });

  it("refuses a delivery of the other carrier", async () => {
    const route = await plannedRoute([]);
    const foreign = await seedDelivery(B, "Cliente da outra");

    await expect(
      context.addStops.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        deliveryIds: [foreign],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DELIVERY_NOT_BELONG_BUSINESS",
    });

    expect(orderOf(route.id)).toHaveLength(0);
  });

  it("refuses a delivery that is already out on the street", async () => {
    const onRoad = await seedDelivery();

    const other = await plannedRoute([onRoad]);

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: other.id,
    });

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId: other.id,
    });

    const route = await plannedRoute([]);

    await expect(
      context.addStops.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        deliveryIds: [onRoad],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DELIVERY_NOT_ROUTABLE",
    });
  });

  it("refuses to add to a route that already departed", async () => {
    const route = await plannedRoute([await seedDelivery()]);

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

    const extra = await seedDelivery(A, "Tarde demais");

    // The driver already has the plan on the screen in their hand. Adding to
    // it would change what they were told to do without telling them.
    await expect(
      context.addStops.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        deliveryIds: [extra],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_STATUS_CONFLICT" });

    expect(orderOf(route.id)).toHaveLength(1);
  });

  it("refuses the other carrier reaching this route at all", async () => {
    const route = await plannedRoute([]);
    const delivery = await seedDelivery(B);

    await expect(
      context.addStops.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
        deliveryIds: [delivery],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("removing a stop", () => {
  it("puts the delivery back in the unassigned pool", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    const [stopId] = orderOf(route.id);

    await context.removeStop.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      stopId,
    });

    expect(orderOf(route.id)).toHaveLength(0);

    const row = context.deliveryRepository.deliveries.find(
      (entry) => entry.id === delivery,
    )!;

    // The delivery keeps its own status — being taken off a route never
    // changed it. Only the driver and vehicle shadow is cleared.
    expect(row.status).toBe("PENDING");
    expect(row.driverId).toBeNull();
    expect(row.vehicleId).toBeNull();
  });

  it("frees the delivery for another route straight away", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    await context.removeStop.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      stopId: orderOf(route.id)[0],
    });

    const replacement = await plannedRoute([delivery]);

    expect(replacement.stops).toHaveLength(1);
  });

  it("refuses a stop id that does not exist", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await expect(
      context.removeStop.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        stopId: "018f0000-0000-7000-8000-00000000dead",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_STOP_NOT_FOUND" });
  });

  it("refuses a stop that belongs to a different route", async () => {
    const mine = await plannedRoute([await seedDelivery()]);
    const other = await plannedRoute([await seedDelivery(A, "Outra rota")]);

    const [foreignStop] = orderOf(other.id);

    await expect(
      context.removeStop.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: mine.id,
        stopId: foreignStop,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(orderOf(other.id)).toHaveLength(1);
  });

  it("refuses once the route has departed", async () => {
    const route = await plannedRoute([await seedDelivery()]);

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

    // Removing a stop from a running route would erase an address the driver
    // may already be standing at. Cancelling the delivery is the way to call
    // one off, and it leaves a trail.
    await expect(
      context.removeStop.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        stopId: orderOf(route.id)[0],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(orderOf(route.id)).toHaveLength(1);
  });
});

describe("reordering the stops", () => {
  async function routeOfThree() {
    const route = await plannedRoute([
      await seedDelivery(A, "Primeira"),
      await seedDelivery(A, "Segunda"),
      await seedDelivery(A, "Terceira"),
    ]);

    return { route, stops: orderOf(route.id) };
  }

  it("rewrites the whole order", async () => {
    const { route, stops } = await routeOfThree();
    const [first, second, third] = stops;

    await context.reorder.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      orderedStopIds: [third, first, second],
    });

    expect(orderOf(route.id)).toEqual([third, first, second]);
  });

  it("leaves the sequences unique and evenly spaced", async () => {
    const { route, stops } = await routeOfThree();

    await context.reorder.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      orderedStopIds: [stops[2], stops[1], stops[0]],
    });

    const sequences = sequencesOf(route.id);

    // Unique, because @@unique([routeId, sequence]) says so — and a reorder
    // that collided halfway through would be the way to violate it.
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([10, 20, 30]);
  });

  it("refuses a list that leaves a stop out", async () => {
    const { route, stops } = await routeOfThree();
    const before = orderOf(route.id);

    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[1], stops[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_REORDER_MISMATCH" });

    expect(orderOf(route.id)).toEqual(before);
  });

  it("refuses a list naming a stop that is not on this route", async () => {
    const { route, stops } = await routeOfThree();
    const other = await plannedRoute([await seedDelivery(A, "De outra rota")]);

    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[0], stops[1], orderOf(other.id)[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_REORDER_MISMATCH" });
  });

  it("refuses a list that repeats a stop, and says so plainly", async () => {
    const { route, stops } = await routeOfThree();

    // Caught before the set comparison, which would have called this a
    // mismatch: "você enviou a mesma parada duas vezes" is a different problem
    // from "a rota mudou", and only one of them is fixed by refreshing.
    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[0], stops[0], stops[1]],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ROUTE_REORDER_DUPLICATE",
    });
  });

  it("refuses the stale list of a dispatcher whose colleague added a stop", async () => {
    const { route, stops } = await routeOfThree();

    // The screen this dispatcher is looking at was rendered before this.
    await context.addStops.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      deliveryIds: [await seedDelivery(A, "Adicionada por outro")],
    });

    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[2], stops[1], stops[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_REORDER_MISMATCH" });

    // Nothing partial: the new stop is still last and the three originals are
    // still in their original order.
    expect(orderOf(route.id).slice(0, 3)).toEqual(stops);
    expect(orderOf(route.id)).toHaveLength(4);
  });

  it("refuses the stale list of a dispatcher whose colleague removed one", async () => {
    const { route, stops } = await routeOfThree();

    await context.removeStop.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      stopId: stops[1],
    });

    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[2], stops[1], stops[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_REORDER_MISMATCH" });

    expect(orderOf(route.id)).toEqual([stops[0], stops[2]]);
  });

  it("refuses once the route has departed", async () => {
    const { route, stops } = await routeOfThree();

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

    // The order is what the driver is following on the screen in their hand.
    await expect(
      context.reorder.execute({
        userId: DISPATCHER_A,
        businessId: A,
        routeId: route.id,
        orderedStopIds: [stops[2], stops[1], stops[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_STATUS_CONFLICT" });

    expect(orderOf(route.id)).toEqual(stops);
  });

  it("refuses the other carrier, without telling it the route exists", async () => {
    const { route, stops } = await routeOfThree();

    await expect(
      context.reorder.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
        orderedStopIds: [stops[2], stops[1], stops[0]],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(orderOf(route.id)).toEqual(stops);
  });
});

describe("reading routes back", () => {
  it("reports progress without the panel recounting the stops", async () => {
    const first = await seedDelivery(A, "Uma");
    const route = await plannedRoute([first, await seedDelivery(A, "Duas")]);

    const before = await context.get.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    expect(before.progress).toMatchObject({ total: 2, done: 0 });

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

    await context.routeRepository.settleStopForDelivery(first, A, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    const after = await context.get.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    expect(after.progress).toMatchObject({ total: 2, done: 1 });
  });

  it("answers 404 for a route of the other carrier", async () => {
    const route = await plannedRoute([]);

    await expect(
      context.get.execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not let a driver open a route that is not theirs", async () => {
    // Same 404: the driver of the next truck must not learn today's plan by
    // guessing an id.
    const route = await plannedRoute([]);

    await context.routeRepository.updateRoute(route.id, A, {
      driverId: "018f0000-0000-7000-8000-0000000000d9",
    });

    await expect(
      context.get.execute({
        userId: DRIVER_USER_A,
        businessId: A,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("shows a driver only their own routes in the listing", async () => {
    await plannedRoute([]);

    const mine = await plannedRoute([]);

    await context.routeRepository.updateRoute(mine.id, A, {
      driverId: "018f0000-0000-7000-8000-0000000000d9",
    });

    const listing = await context.list.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      page: 1,
      pageSize: 10,
    });

    // Two routes on the company, one of them this driver's.
    expect(listing.data).toHaveLength(1);
    expect(listing.data[0].driverId).toBe(DRIVER_A);
  });

  it("ignores a driverId a driver tries to widen the listing with", async () => {
    const other = "018f0000-0000-7000-8000-0000000000d9";

    const foreign = await plannedRoute([]);

    await context.routeRepository.updateRoute(foreign.id, A, {
      driverId: other,
    });

    const listing = await context.list.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      page: 1,
      pageSize: 10,
      driverId: other,
    });

    // The driver's own id REPLACES what was sent — it is not a filter they can
    // widen.
    expect(listing.data).toHaveLength(0);
  });

  it("does not show the other carrier's routes in a listing", async () => {
    await plannedRoute([]);

    const listing = await context.list.execute({
      userId: DISPATCHER_B,
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(listing.total).toBe(0);
    expect(listing.data).toHaveLength(0);
  });
});
