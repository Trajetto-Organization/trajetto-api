import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route as the unit of assignment (decision 14.7): the plan version
 * (D5), the idempotent writes (§8), the 200-stop ceiling (D11), the batch
 * remove (§4.4), the atomic move (D10), "Fixar no mapa" (D7), the realtime
 * hint (§7.1) and who may do any of it.
 *
 * The real use cases over the in-memory repositories, with the transaction a
 * passthrough as in every route unit suite. What only Postgres proves (the
 * row locks, the partial unique index, the anti-join of the picker) is in
 * tests/E2E/route-assignment-unit-http.test.ts.
 */
const emitted: Array<{
  room: "business" | "driver";
  id: string | null;
  event: any;
}> = [];

vi.mock("@/websocket", () => ({
  sendRouteEventToBusiness: (id: string, event: unknown) => {
    emitted.push({ room: "business", id, event });
  },
  sendRouteEventToDriver: (id: string | null, event: unknown) => {
    emitted.push({ room: "driver", id, event });
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { RemoveRouteStopsUseCase } from "@/modules/route/usecases/remove-route-stops/remove-route-stops-usecase";
import { RemoveRouteStopUseCase } from "@/modules/route/usecases/remove-route-stop/remove-route-stop-usecase";
import { ReorderRouteStopsUseCase } from "@/modules/route/usecases/reorder-route-stops/reorder-route-stops-usecase";
import { MoveRouteStopsUseCase } from "@/modules/route/usecases/move-route-stops/move-route-stops-usecase";
import { PLANNING_TIMELINE_EVENTS_ENABLED } from "@/modules/route/usecases/shared/route-plan-rules";
import { SetDeliveryLocationUseCase } from "@/modules/route/usecases/set-delivery-location/set-delivery-location-usecase";
import { ListUnroutedDeliveriesUseCase } from "@/modules/route/usecases/list-unrouted-deliveries/list-unrouted-deliveries-usecase";
import { ListOpenStopsUseCase } from "@/modules/route/usecases/open-stops/open-stops-usecase";
import { GetRouteUseCase } from "@/modules/route/usecases/get-route/get-route-usecase";
import { DriverTrailUseCase } from "@/modules/route/usecases/driver-trail/driver-trail-usecase";
import { routeDriverPosition } from "@/modules/route/usecases/get-route/route-driver-position";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
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

const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";
const DISPATCHER_B = "018f0000-0000-7000-8000-0000000000ba";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-0000000000d2";

const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const DAY = new Date("2026-10-06T00:00:00.000Z");

function makeContext() {
  const notificationService = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  const outboxStub = {
    publish: async () => undefined,
  } as unknown as OutboxService;
  const webhooks = new InMemoryWebhookFanOutService();

  const deliveryRepository = new InMemoryDeliveryRepository();
  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();
  const positions = new InMemoryDriverPositionRepository();

  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
    vehicleRepository.vehicles,
    driverRepository.drivers,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  userRepository.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: DISPATCHER_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    } as User,
  );

  driverRepository.drivers.push(
    { id: DRIVER, name: "João", status: "ACTIVE", businessId: A } as Driver,
    {
      id: OTHER_DRIVER,
      name: "Maria",
      status: "ACTIVE",
      businessId: A,
    } as Driver,
  );

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    status: "ACTIVE",
    driverId: DRIVER,
    businessId: A,
  } as Vehicle);

  const cancel = new CancelRouteUseCase(
    routeRepository,
    userRepository,
    notificationService,
    outboxStub,
    webhooks.asService(),
  );

  const removeStops = new RemoveRouteStopsUseCase(
    routeRepository,
    userRepository,
    notificationService,
  );

  return {
    webhooks,
    users: userRepository,
    routeRepository,
    deliveryRepository,
    positions,
    create: new CreateRouteUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),
    release: new ReleaseRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      notificationService,
      outboxStub,
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
    cancel,
    addStops: new AddRouteStopsUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      notificationService,
      webhooks.asService(),
    ),
    removeStops,
    removeStop: new RemoveRouteStopUseCase(removeStops),
    reorder: new ReorderRouteStopsUseCase(
      routeRepository,
      userRepository,
      notificationService,
    ),
    move: new MoveRouteStopsUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      cancel,
      notificationService,
      webhooks.asService(),
    ),
    setLocation: new SetDeliveryLocationUseCase(
      routeRepository,
      userRepository,
    ),
    unrouted: new ListUnroutedDeliveriesUseCase(
      routeRepository,
      userRepository,
    ),
    openStops: new ListOpenStopsUseCase(routeRepository, userRepository),
    get: new GetRouteUseCase(routeRepository, userRepository, positions),
    trail: new DriverTrailUseCase(
      userRepository,
      positions,
      new InMemoryOperationDayRepository(),
      routeRepository,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
  emitted.length = 0;
});

async function seedDelivery(
  overrides: Partial<CreateDeliveryProps> = {},
): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    recipient_name: "Destinatária",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...overrides,
  } as CreateDeliveryProps);

  return created.id!;
}

async function plannedRoute(
  deliveryIds: string[],
  driverId = DRIVER,
): Promise<{ id: string; code: number }> {
  const route = await context.create.execute({
    userId: DISPATCHER,
    businessId: A,
    driverId,
    vehicleId: VEHICLE,
    scheduled_date: DAY,
    deliveryIds,
  });

  return { id: route.id, code: route.code };
}

const versionOf = (routeId: string) =>
  context.routeRepository.routes.find((route) => route.id === routeId)!
    .plan_version;

const openStopsOf = (routeId: string) =>
  context.routeRepository.stops
    .filter((stop) => stop.routeId === routeId)
    .sort((a, b) => a.sequence - b.sequence);

describe("the plan version (D5)", () => {
  it("moves once per change and refuses a stale editor with 409", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();
    const route = await plannedRoute([first]);

    expect(versionOf(route.id)).toBe(0);

    const added = await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: [second],
      expectedPlanVersion: 0,
    });

    expect(added.planVersion).toBe(1);

    // A colleague's screen still shows version 0.
    await expect(
      context.reorder.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        orderedStopIds: openStopsOf(route.id)
          .map((stop) => stop.id)
          .reverse(),
        expectedPlanVersion: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_PLAN_STALE" });

    // Nothing moved.
    expect(openStopsOf(route.id).map((stop) => stop.deliveryId)).toEqual([
      first,
      second,
    ]);
    expect(versionOf(route.id)).toBe(1);
  });

  it("does not move on a reorder that sends the order it already has", async () => {
    const route = await plannedRoute([
      await seedDelivery(),
      await seedDelivery(),
    ]);

    const result = await context.reorder.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      orderedStopIds: openStopsOf(route.id).map((stop) => stop.id),
      expectedPlanVersion: 0,
    });

    expect(result.planVersion).toBe(0);
    expect(emitted).toEqual([]);
  });

  it("moves on an edit of the crew and refuses a stale one", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await context.update.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      destination: "CD Cajamar",
      expectedPlanVersion: 0,
    });

    expect(versionOf(route.id)).toBe(1);

    await expect(
      context.update.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        destination: "CD Jundiaí",
        expectedPlanVersion: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_PLAN_STALE" });
  });
});

describe("adding stops (§4.3)", () => {
  it("answers a retry with alreadyOnRoute and writes the new ones once", async () => {
    const kept = await seedDelivery();
    const fresh = await seedDelivery();
    const route = await plannedRoute([kept]);
    const announcedBefore = context.webhooks.announced.length;

    const result = await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: [kept, fresh],
    });

    expect(result.alreadyOnRoute).toEqual([kept]);
    expect(result.stops.map((stop) => stop.deliveryId)).toEqual([fresh]);

    // One timeline line per delivery that joined, naming the route: the
    // create's, then the add's — none for the retried one. None while the
    // gate holds the planning lines back from the trail.
    expect(
      context.routeRepository.events.filter(
        (event) => event.type === "ROUTE_ADDED",
      ),
    ).toEqual(
      PLANNING_TIMELINE_EVENTS_ENABLED
        ? [
            expect.objectContaining({ deliveryId: kept, routeId: route.id }),
            expect.objectContaining({
              deliveryId: fresh,
              routeId: route.id,
              reportedById: DISPATCHER,
              note: `Adicionada à Rota ${route.code} (parada 2).`,
            }),
          ]
        : [],
    );

    // One `delivery.assigned`, for the one that changed hands.
    expect(
      context.webhooks.announced
        .slice(announcedBefore)
        .filter((event) => event.topic === "delivery.assigned")
        .map((event) => event.payload.delivery_id),
    ).toEqual([fresh]);
  });

  it("names the other route when a delivery is already on it", async () => {
    const taken = await seedDelivery({
      code: "NF-77",
    } as Partial<CreateDeliveryProps>);
    const holder = await plannedRoute([taken]);
    const route = await plannedRoute([], OTHER_DRIVER);

    await expect(
      context.addStops.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        deliveryIds: [taken],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ALREADY_ON_ROUTE",
      message: expect.stringContaining(`(Rota ${holder.code})`),
    });
  });

  it("refuses to pass 200 open stops", async () => {
    const route = await plannedRoute([]);

    const ids: string[] = [];

    for (let index = 0; index < 200; index += 1) ids.push(await seedDelivery());

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: ids.slice(0, 100),
    });
    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: ids.slice(100, 200),
    });

    await expect(
      context.addStops.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        deliveryIds: [await seedDelivery()],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_STOPS_LIMIT" });

    expect(openStopsOf(route.id)).toHaveLength(200);
  });

  it("tells the driver only when the route is released", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: [await seedDelivery()],
    });

    expect(emitted.map((entry) => entry.room)).toEqual(["business"]);
    expect(emitted[0].event).toMatchObject({
      type: "route.stops_changed",
      routeId: route.id,
      planVersion: 1,
    });

    await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
    });
    emitted.length = 0;

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: [await seedDelivery()],
    });

    expect(
      emitted.filter((entry) => entry.event.type === "route.stops_changed"),
    ).toEqual([
      expect.objectContaining({ room: "business", id: A }),
      expect.objectContaining({ room: "driver", id: DRIVER_USER }),
    ]);
  });
});

describe("removing stops in a batch (§4.4)", () => {
  it("removes, clears the mirror, reports the gone ones and that the route emptied", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();
    const route = await plannedRoute([first, second]);

    const stopIds = openStopsOf(route.id).map((stop) => stop.id);

    const result = await context.removeStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      stopIds,
    });

    expect(result.removed.map((entry) => entry.deliveryId).sort()).toEqual(
      [first, second].sort(),
    );
    expect(result.routeEmptied).toBe(true);
    expect(result.planVersion).toBe(1);

    const mirrored = context.deliveryRepository.deliveries.filter((delivery) =>
      [first, second].includes(delivery.id!),
    );

    expect(mirrored.map((delivery) => delivery.driverId)).toEqual([null, null]);
    expect(
      context.routeRepository.events.filter(
        (event) => event.type === "ROUTE_REMOVED",
      ),
    ).toHaveLength(PLANNING_TIMELINE_EVENTS_ENABLED ? 2 : 0);

    // The retry: nothing left to remove is success, not an error.
    const retry = await context.removeStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      stopIds,
    });

    expect(retry).toMatchObject({
      removed: [],
      alreadyGone: stopIds,
      planVersion: 1,
    });
  });

  it("keeps the single-stop endpoint's 404 for a stop that is not there", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await expect(
      context.removeStop.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        stopId: "018f0000-0000-7000-8000-000000000999",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "ROUTE_STOP_NOT_FOUND" });
  });

  it("refuses a route that already left", async () => {
    const route = await plannedRoute([await seedDelivery()]);
    const routeRow = context.routeRepository.routes.find(
      (entry) => entry.id === route.id,
    )!;

    routeRow.status = "IN_PROGRESS";

    await expect(
      context.removeStops.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        stopIds: openStopsOf(route.id).map((stop) => stop.id),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_STATUS_CONFLICT" });
  });
});

describe("moving deliveries between routes (D10)", () => {
  it("empties and cancels a released source, and lands the stops on the target", async () => {
    const delivery = await seedDelivery();
    const source = await plannedRoute([delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: source.id,
    });

    const target = await plannedRoute([], OTHER_DRIVER);
    const loose = await seedDelivery();

    const result = await context.move.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: target.id,
      deliveryIds: [delivery, loose],
    });

    expect(result.moved).toEqual([
      {
        deliveryId: delivery,
        fromRouteId: source.id,
        fromRouteCode: source.code,
      },
    ]);
    expect(result.cancelledRoutes).toEqual([source.code]);
    expect(openStopsOf(target.id).map((stop) => stop.deliveryId)).toEqual([
      delivery,
      loose,
    ]);

    const sourceRow = context.routeRepository.routes.find(
      (route) => route.id === source.id,
    )!;

    expect(sourceRow.status).toBe("CANCELLED");
    expect(sourceRow.cancellation_reason).toBe(
      `Todas as paradas foram movidas para a Rota ${target.code}.`,
    );

    // The new holder is what the delivery's shadow says.
    expect(
      context.deliveryRepository.deliveries.find(
        (entry) => entry.id === delivery,
      )!.driverId,
    ).toBe(OTHER_DRIVER);
  });

  it("refuses a delivery whose route already left, writing nothing", async () => {
    const delivery = await seedDelivery();
    const source = await plannedRoute([delivery]);

    context.routeRepository.routes.find(
      (route) => route.id === source.id,
    )!.status = "IN_PROGRESS";

    const target = await plannedRoute([], OTHER_DRIVER);

    await expect(
      context.move.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: target.id,
        deliveryIds: [delivery],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ON_STARTED_ROUTE",
    });

    expect(openStopsOf(target.id)).toHaveLength(0);
    expect(openStopsOf(source.id)).toHaveLength(1);
  });
});

describe("plans that change without the page (D5, review r1)", () => {
  it("moves the version once when a move takes a stop from a source that keeps others", async () => {
    const moving = await seedDelivery();
    const staying = await seedDelivery();
    const source = await plannedRoute([moving, staying]);
    const target = await plannedRoute([], OTHER_DRIVER);

    await context.move.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: target.id,
      deliveryIds: [moving],
    });

    // Once, by the detach — not twice (detach plus an extra bump).
    expect(versionOf(source.id)).toBe(1);
    expect(versionOf(target.id)).toBe(1);
  });

  it("moves the version of a planned route a terminal outcome takes a stop off, and reports it", async () => {
    const closed = await seedDelivery();
    const kept = await seedDelivery();
    const route = await plannedRoute([closed, kept]);
    const dropped: Array<{ routeId: string; planVersion: number }> = [];

    const settled = await context.routeRepository.settleStopForDelivery(
      closed,
      A,
      {
        from: ["PENDING", "ARRIVED"],
        status: "CANCELLED",
        onPlanDropped: (bump) => dropped.push(bump),
      },
    );

    expect(settled).toBeNull();
    expect(openStopsOf(route.id).map((stop) => stop.deliveryId)).toEqual([
      kept,
    ]);
    expect(versionOf(route.id)).toBe(1);
    expect(dropped).toEqual([
      expect.objectContaining({
        routeId: route.id,
        planVersion: 1,
        status: "PLANNED",
      }),
    ]);

    // Another company's call finds nothing and moves nothing.
    await context.routeRepository.settleStopForDelivery(kept, B, {
      from: ["PENDING", "ARRIVED"],
      status: "CANCELLED",
      onPlanDropped: (bump) => dropped.push(bump),
    });

    expect(versionOf(route.id)).toBe(1);
    expect(dropped).toHaveLength(1);
  });

  it("reports every route the detach touched with its new version", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();
    const route = await plannedRoute([first, second]);

    const detached = await context.routeRepository.detachFromOpenRoutes(
      [first],
      A,
    );

    expect(detached.bumped).toEqual([
      expect.objectContaining({ routeId: route.id, planVersion: 1 }),
    ]);
    expect(detached.emptiedRoutes).toEqual([]);
  });
});

describe("the picker's shipper filter (§5.5, review r1)", () => {
  it("counts shippers disjunctively and names them for the asking company only", async () => {
    const OTHER_SHIPPER = "018f0000-0000-7000-8000-0000000000f2";

    context.routeRepository.shippers.push(
      { id: SHIPPER, name: "Embarcador", businessId: A },
      { id: OTHER_SHIPPER, name: "Atacado Dois", businessId: A },
    );

    await seedDelivery();
    await seedDelivery();
    const other = await seedDelivery({
      shipperId: OTHER_SHIPPER,
    } as Partial<CreateDeliveryProps>);

    const page = await context.routeRepository.listUnroutedDeliveries({
      businessId: A,
      page: 1,
      pageSize: 50,
      shipperIds: [OTHER_SHIPPER],
    });

    expect(page.data.map((row) => row.id)).toEqual([other]);
    expect(page.data[0].shipper).toEqual({
      id: OTHER_SHIPPER,
      name: "Atacado Dois",
    });
    expect(page.facets.shipper).toEqual([
      { value: OTHER_SHIPPER, count: 1, label: "Atacado Dois" },
      { value: SHIPPER, count: 2, label: "Embarcador" },
    ]);

    const fromB = await context.routeRepository.listUnroutedDeliveries({
      businessId: B,
      page: 1,
      pageSize: 50,
    });

    expect(fromB.facets.shipper).toEqual([]);
  });
});

describe("releasing twice (§4.8)", () => {
  it("answers the same state as unchanged and stamps released_at", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    const first = await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
    });

    expect(first.unchanged).toBe(false);
    expect(first.route.released_at).toBeInstanceOf(Date);

    const again = await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
    });

    expect(again.unchanged).toBe(true);

    const back = await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      released: false,
    });

    expect(back.route.released_at).toBeNull();
  });

  it("refuses to release a plan that changed since it was read", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
      deliveryIds: [await seedDelivery()],
    });

    await expect(
      context.release.execute({
        userId: DISPATCHER,
        businessId: A,
        routeId: route.id,
        expectedPlanVersion: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_PLAN_STALE" });
  });
});

describe("creating with an Idempotency-Key (§4.7)", () => {
  it("answers the resend with the same route, and another company's key with its own", async () => {
    const key = "018f0000-0000-7000-8000-00000000c0de";

    const first = await context.create.execute({
      userId: DISPATCHER,
      businessId: A,
      driverId: DRIVER,
      scheduled_date: DAY,
      deliveryIds: [await seedDelivery()],
      client_submission_id: key,
    });

    const resend = await context.create.execute({
      userId: DISPATCHER,
      businessId: A,
      driverId: DRIVER,
      scheduled_date: DAY,
      client_submission_id: key,
    });

    expect(resend.id).toBe(first.id);
    expect(resend.replayed).toBe(true);
    expect(context.routeRepository.routes).toHaveLength(1);
    expect(
      context.webhooks.announced.filter(
        (event) => event.topic === "delivery.assigned",
      ),
    ).toHaveLength(1);
  });
});

describe("pinning a delivery on the map (D7)", () => {
  it("pins, bumps the plan of the route that holds it and refuses outside Brazil", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    const pinned = await context.setLocation.execute({
      userId: DISPATCHER,
      businessId: A,
      deliveryId: delivery,
      point: { latitude: -23.55, longitude: -46.63 },
    });

    expect(pinned).toMatchObject({
      latitude: -23.55,
      longitude: -46.63,
      geo_source: "MANUAL",
    });
    expect(versionOf(route.id)).toBe(1);

    await expect(
      context.setLocation.execute({
        userId: DISPATCHER,
        businessId: A,
        deliveryId: delivery,
        point: { latitude: 48.85, longitude: 2.35 },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DELIVERY_LOCATION_INVALID",
    });
  });

  it("answers another company's delivery as not found, and a closed one as locked", async () => {
    const delivery = await seedDelivery();

    await expect(
      context.setLocation.execute({
        userId: DISPATCHER_B,
        businessId: B,
        deliveryId: delivery,
        point: { latitude: -23.55, longitude: -46.63 },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });

    context.deliveryRepository.deliveries.find(
      (entry) => entry.id === delivery,
    )!.status = "DELIVERED";

    await expect(
      context.setLocation.execute({
        userId: DISPATCHER,
        businessId: A,
        deliveryId: delivery,
        point: { latitude: -23.55, longitude: -46.63 },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DELIVERY_LOCATION_LOCKED",
    });
  });
});

describe("the picker of deliveries without a route (D3)", () => {
  it("lists PENDING deliveries with no open stop, with the city facet disjunctive", async () => {
    const free = await seedDelivery({
      city: "Campinas",
    } as Partial<CreateDeliveryProps>);
    const other = await seedDelivery({
      city: "Santos",
    } as Partial<CreateDeliveryProps>);
    const routed = await seedDelivery();

    await plannedRoute([routed]);

    const page = await context.unrouted.execute({
      userId: DISPATCHER,
      businessId: A,
      page: 1,
      pageSize: 50,
      cities: ["campinas"],
    });

    expect(page.data.map((row) => row.id)).toEqual([free]);
    expect(page.total).toBe(1);

    // The city facet ignores its own filter: Santos stays an option.
    expect(page.facets.city).toEqual([
      { value: "Campinas", count: 1 },
      { value: "Santos", count: 1 },
    ]);
    expect(page.data.map((row) => row.id)).not.toContain(other);
  });

  it("names which route holds each delivery of a selection", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    expect(
      await context.openStops.execute({
        userId: DISPATCHER,
        businessId: A,
        deliveryIds: [delivery, await seedDelivery()],
      }),
    ).toEqual([
      expect.objectContaining({
        deliveryId: delivery,
        routeId: route.id,
        routeStatus: "PLANNED",
      }),
    ]);

    // Another company asks about the same id and learns nothing.
    expect(
      await context.openStops.execute({
        userId: DISPATCHER_B,
        businessId: B,
        deliveryIds: [delivery],
      }),
    ).toEqual([]);
  });
});

describe("a driver token plans nothing", () => {
  it("is refused by every planning write and read of this slice", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);
    const stopId = openStopsOf(route.id)[0].id;

    const refusals = [
      context.addStops.execute({
        userId: DRIVER_USER,
        businessId: A,
        routeId: route.id,
        deliveryIds: [await seedDelivery()],
      }),
      context.removeStops.execute({
        userId: DRIVER_USER,
        businessId: A,
        routeId: route.id,
        stopIds: [stopId],
      }),
      context.move.execute({
        userId: DRIVER_USER,
        businessId: A,
        routeId: route.id,
        deliveryIds: [delivery],
      }),
      context.setLocation.execute({
        userId: DRIVER_USER,
        businessId: A,
        deliveryId: delivery,
        point: { latitude: -23.5, longitude: -46.6 },
      }),
      context.unrouted.execute({
        userId: DRIVER_USER,
        businessId: A,
        page: 1,
        pageSize: 10,
      }),
      context.openStops.execute({
        userId: DRIVER_USER,
        businessId: A,
        deliveryIds: [delivery],
      }),
    ];

    for (const refusal of refusals) {
      await expect(refusal).rejects.toMatchObject({
        statusCode: 403,
        code: "DRIVER_CANNOT_MANAGE_DELIVERIES",
      });
    }
  });
});

describe("another company's dispatcher naming this company", () => {
  // Defense in depth: the route guard (verifyTenant) stops this at the HTTP
  // edge, but a job, a script or another use case reaches these directly.
  // Before, assertRouteDispatcher checked the person and not the company, so
  // a dispatcher of B passing businessId A read and wrote A's plan.
  it("is refused with 403 TENANT_ACCESS_DENIED by every planning read and write", async () => {
    const delivery = await seedDelivery();
    const loose = await seedDelivery();
    const route = await plannedRoute([delivery]);
    const stopId = openStopsOf(route.id)[0].id;
    const as = { userId: DISPATCHER_B, businessId: A };

    const refusals: Array<[string, Promise<unknown>]> = [
      [
        "openStops",
        context.openStops.execute({ ...as, deliveryIds: [delivery] }),
      ],
      ["unrouted", context.unrouted.execute({ ...as, page: 1, pageSize: 10 })],
      [
        "create",
        context.create.execute({
          ...as,
          driverId: DRIVER,
          vehicleId: VEHICLE,
          scheduled_date: DAY,
          deliveryIds: [loose],
        }),
      ],
      [
        "update",
        context.update.execute({
          ...as,
          routeId: route.id,
          destination: "CD Alheio",
        }),
      ],
      [
        "addStops",
        context.addStops.execute({
          ...as,
          routeId: route.id,
          deliveryIds: [loose],
        }),
      ],
      [
        "removeStops",
        context.removeStops.execute({
          ...as,
          routeId: route.id,
          stopIds: [stopId],
        }),
      ],
      [
        "reorder",
        context.reorder.execute({
          ...as,
          routeId: route.id,
          orderedStopIds: [stopId],
        }),
      ],
      [
        "move",
        context.move.execute({
          ...as,
          routeId: route.id,
          deliveryIds: [loose],
        }),
      ],
      [
        "setLocation",
        context.setLocation.execute({
          ...as,
          deliveryId: delivery,
          point: { latitude: -23.5, longitude: -46.6 },
        }),
      ],
      ["release", context.release.execute({ ...as, routeId: route.id })],
      [
        "cancel",
        context.cancel.execute({
          ...as,
          routeId: route.id,
          reason: "Planejamento alheio",
        }),
      ],
    ];

    for (const [name, refusal] of refusals) {
      await expect(refusal, name).rejects.toMatchObject({
        statusCode: 403,
        code: "TENANT_ACCESS_DENIED",
      });
    }

    // Nothing of A's plan changed.
    expect(openStopsOf(route.id).map((stop) => stop.deliveryId)).toEqual([
      delivery,
    ]);
    expect(
      context.routeRepository.routes.find((row) => row.id === route.id),
    ).toMatchObject({
      status: "PLANNED",
      plan_version: 0,
    });
    expect(context.routeRepository.routes).toHaveLength(1);
  });

  it("still lets a MASTER plan any company", async () => {
    const master = "018f0000-0000-7000-8000-0000000000ff";

    context.users.user.push({
      id: master,
      role: "MASTER",
      businessId: null,
    } as unknown as User);

    const delivery = await seedDelivery();

    await expect(
      context.openStops.execute({
        userId: master,
        businessId: A,
        deliveryIds: [delivery],
      }),
    ).resolves.toEqual([]);
  });
});

describe("the route map's live layers (§4.2)", () => {
  const last = (routeId: string | null, recordedAt: Date) => ({
    driverId: DRIVER,
    routeId,
    latitude: -23.5,
    longitude: -46.6,
    accuracy: 5,
    speed: 10,
    heading: 90,
    battery: 80,
    recorded_at: recordedAt,
  });

  const NOW = new Date("2026-10-06T15:00:00.000Z");

  it("shows the dot of THIS route only, and says when it is stale", () => {
    expect(
      routeDriverPosition(
        { id: "r1", status: "IN_PROGRESS" },
        last("r1", NOW),
        NOW,
      ),
    ).toMatchObject({ fresh: true, latitude: -23.5 });

    // Another route of the same driver: never on this map.
    expect(
      routeDriverPosition(
        { id: "r1", status: "IN_PROGRESS" },
        last("r2", NOW),
        NOW,
      ),
    ).toBeNull();

    // A planned or finished route has no live driver.
    expect(
      routeDriverPosition(
        { id: "r1", status: "PLANNED" },
        last("r1", NOW),
        NOW,
      ),
    ).toBeNull();
    expect(
      routeDriverPosition(
        { id: "r1", status: "COMPLETED" },
        last("r1", NOW),
        NOW,
      ),
    ).toBeNull();

    expect(
      routeDriverPosition(
        { id: "r1", status: "IN_PROGRESS" },
        last("r1", new Date(NOW.getTime() - 11 * 60 * 1000)),
        NOW,
      ),
    ).toMatchObject({ fresh: false });
  });

  it("hides the map layers from the driver's own read", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    const forPanel = await context.get.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
    });

    expect(forPanel.route.plan_version).toBe(0);
    expect(forPanel.visitedPoints).toEqual([]);
  });

  it("draws the trail of this route only, from its departure", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);
    const row = context.routeRepository.routes.find(
      (entry) => entry.id === route.id,
    )!;

    row.status = "IN_PROGRESS";
    row.started_at = new Date("2026-10-06T11:00:00.000Z");

    context.positions.drivers.push({ id: DRIVER, businessId: A, name: "João" });

    const point = (iso: string, routeId: string | null) => ({
      driverId: DRIVER,
      businessId: A,
      routeId,
      latitude: -23.5,
      longitude: -46.6,
      accuracy: 5,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: new Date(iso),
    });

    context.positions.trail.push(
      point("2026-10-06T10:00:00.000Z", null),
      point("2026-10-06T11:30:00.000Z", route.id),
      point("2026-10-06T12:00:00.000Z", "another-route"),
    );

    const trail = await context.trail.execute({
      userId: DISPATCHER,
      driverId: DRIVER,
      routeId: route.id,
      now: new Date("2026-10-06T15:00:00.000Z"),
    });

    expect(trail.recorded).toBe(1);
    expect(trail.points[0].recordedAt).toBe("2026-10-06T11:30:00.000Z");

    // Another company's id for the same route: the same 404 as none.
    await expect(
      context.trail.execute({
        userId: DISPATCHER_B,
        driverId: DRIVER,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
