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

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

// Nothing here asserts on webhooks; the use cases simply require one.
const webhookStub = new InMemoryWebhookFanOutService();

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
 * The write path of the route module: creating, releasing, departing,
 * cancelling.
 *
 * Two of the guarantees under test live in Postgres as partial unique indexes
 * rather than in application code, and the in-memory repository mirrors both.
 * That mirroring is what makes these tests mean anything — a fake that
 * accepted writes the real repository refuses would let this file prove the
 * opposite of the truth.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-0000000000d2";

const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const TOMORROW = new Date("2026-09-15T08:00:00.000Z");

/**
 * Records instead of discarding: the outbox is the only way a use case reaches
 * a driver's phone or a customer's, so what it received IS the notification
 * behaviour under test.
 */
const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];

const outboxStub = {
  publish: async (
    _tx: unknown,
    event: { topic: string; payload: Record<string, unknown> },
  ) => {
    published.push({ topic: event.topic, payload: event.payload });
  },
} as unknown as OutboxService;

function makeContext() {
  const routeRepository = new InMemoryRouteRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();

  const userRepository = new InMemoryUserRepository();

  userRepository.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  driverRepository.drivers.push(
    {
      id: DRIVER,
      name: "João Motorista",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
    {
      id: OTHER_DRIVER,
      name: "Maria Motorista",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
  );

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Vehicle);

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
      webhookStub.asService(),
    ),
    release: new ReleaseRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),
    cancel: new CancelRouteUseCase(
      routeRepository,
      userRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
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

async function seedDelivery(
  context: Context,
  overrides: Partial<CreateDeliveryProps> = {},
): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Maria Destinatária",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...overrides,
  } as CreateDeliveryProps);

  // The route repository mirrors driverId/vehicleId onto these rows, so it has
  // to be able to see them — and it reads the contact details from here when a
  // departure has to tell the people waiting.
  context.routeRepository.deliveries.push({
    id: created.id!,
    businessId: created.businessId,
    driverId: null,
    vehicleId: null,
    status: created.status,
    recipient_name: created.recipient_name,
    recipient_email: created.recipient_email ?? null,
    recipient_telephone: created.recipient_telephone ?? null,
    invoice_number: created.invoice_number ?? null,
    code: created.code ?? null,
  });

  return created.id!;
}

const createRoute = (context: Context, deliveryIds: string[] = []) =>
  context.create.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    scheduled_date: TOMORROW,
    deliveryIds,
  });

let context: Context;

beforeEach(() => {
  context = makeContext();

  // Shared across the file, so a test that reads it has to start empty.
  webhookStub.reset();
});

describe("creating a route", () => {
  it("is born planned, numbered, and invisible to the driver", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    expect(route.status).toBe("PLANNED");
    expect(route.code).toBe(1);
    expect(route.stops).toHaveLength(1);
  });

  it("numbers routes per company, starting at one", async () => {
    await createRoute(context);
    const second = await createRoute(context);

    expect(second.code).toBe(2);
  });

  it("places the stops in the order the dispatcher gave them", async () => {
    const first = await seedDelivery(context);
    const second = await seedDelivery(context);
    const third = await seedDelivery(context);

    const route = await createRoute(context, [third, first, second]);

    expect(route.stops.map((stop) => stop.deliveryId)).toEqual([
      third,
      first,
      second,
    ]);
  });

  it("mirrors the driver onto the deliveries", async () => {
    // Delivery.driverId is the route's shadow: every existing screen reads it,
    // and the route service is its only writer.
    const delivery = await seedDelivery(context);
    await createRoute(context, [delivery]);

    const mirrored = context.routeRepository.deliveries.find(
      (entry) => entry.id === delivery,
    );

    expect(mirrored?.driverId).toBe(DRIVER);
    expect(mirrored?.vehicleId).toBe(VEHICLE);
  });

  it("accepts an empty route, to be filled in later", async () => {
    const route = await createRoute(context, []);

    expect(route.stops).toHaveLength(0);
    expect(route.status).toBe("PLANNED");
  });

  it("refuses a driver from another company", async () => {
    context.driverRepository.drivers.push({
      id: "outsider",
      name: "De outra empresa",
      status: "ACTIVE",
      businessId: OTHER_BUSINESS,
    } as Driver);

    await expect(
      context.create.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: "outsider",
        scheduled_date: TOMORROW,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses an inactive driver", async () => {
    context.driverRepository.drivers[0].status = "INACTIVE";

    await expect(createRoute(context)).rejects.toMatchObject({
      code: "ROUTE_DRIVER_INACTIVE",
    });
  });

  it("refuses a blocked vehicle", async () => {
    context.vehicleRepository.vehicles[0].status = "BLOCKED";

    await expect(createRoute(context)).rejects.toMatchObject({
      code: "ROUTE_VEHICLE_UNAVAILABLE",
    });
  });

  it("refuses a delivery that is not pending", async () => {
    const delivery = await seedDelivery(context);
    context.deliveryRepository.deliveries[0].status = "DELIVERED";

    await expect(createRoute(context, [delivery])).rejects.toMatchObject({
      code: "DELIVERY_NOT_ROUTABLE",
    });
  });

  it("collapses a delivery selected twice", async () => {
    // Otherwise the same delivery becomes two stops on one route, and the
    // driver is asked to deliver it twice.
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery, delivery]);

    expect(route.stops).toHaveLength(1);
  });
});

describe("a delivery already on a route", () => {
  it("cannot be put on a second one", async () => {
    const delivery = await seedDelivery(context);
    await createRoute(context, [delivery]);

    await expect(createRoute(context, [delivery])).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ALREADY_ON_ROUTE",
    });
  });

  it("answers 409 and not 400, because nobody did anything wrong", async () => {
    // The request was well formed and the dispatcher was allowed to make it —
    // somebody else got there first. The screen has to say "refresh", not
    // "you did it wrong".
    const delivery = await seedDelivery(context);
    await createRoute(context, [delivery]);

    await expect(createRoute(context, [delivery])).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("becomes routable again once the route is cancelled", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      reason: "Cliente remarcou",
    });

    const rescheduled = await createRoute(context, [delivery]);

    expect(rescheduled.stops).toHaveLength(1);
  });
});

describe("releasing a route", () => {
  it("hands a ready route to the driver", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    const released = await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    expect(released.status).toBe("RELEASED");
  });

  it("refuses a route with no stops", async () => {
    const route = await createRoute(context, []);

    await expect(
      context.release.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_RELEASABLE" });
  });

  it("refuses a route with no vehicle", async () => {
    const delivery = await seedDelivery(context);

    const route = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: TOMORROW,
      deliveryIds: [delivery],
    });

    await expect(
      context.release.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_RELEASABLE" });
  });

  it("answers 404 — not 403 — for a route of another company", async () => {
    // Deliberately indistinguishable from a route that does not exist. A
    // separate "exists but is not yours" refusal is an oracle: it tells whoever
    // is probing which ids are real, one request at a time.
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await expect(
      context.release.execute({
        userId: DISPATCHER,
        businessId: OTHER_BUSINESS,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // And it really did not act: the route is untouched.
    expect(context.routeRepository.routes[0].status).toBe("PLANNED");
  });

  it("can be pulled back while nothing was worked", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    const planned = await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      released: false,
    });

    expect(planned.status).toBe("PLANNED");

    // The topic follows what happened, not the endpoint's name. This one use
    // case does both directions, and announcing `route.released` for the
    // pull-back would tell a customer's ERP to dispatch a load that just came
    // off the board — with a payload claiming RELEASED over a row that says
    // PLANNED.
    // `delivery.assigned` first, because building the route is what assigns
    // its documents — the same event the batch shortcut used to announce on
    // its own, now fired by whichever path built the route.
    expect(webhookStub.topics()).toEqual([
      "delivery.assigned",
      "route.released",
      "route.unreleased",
    ]);

    const reversal = webhookStub.announced[webhookStub.announced.length - 1];

    expect(reversal.payload.status).toBe("PLANNED");

    // And inside the write's own transaction, so a crash cannot leave the
    // reversal in our database and absent from theirs.
    expect(reversal.transactional).toBe(true);
  });
});

describe("the departure", () => {
  async function releasedRoute(): Promise<string> {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    return route.id;
  }

  it("moves the route to in progress and stamps the time", async () => {
    const routeId = await releasedRoute();

    const started = await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
    });

    expect(started.status).toBe("IN_PROGRESS");
    expect(started.started_at).toBeInstanceOf(Date);
  });

  it("refuses a route that was never released", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await expect(
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROUTE_TRANSITION" });
  });

  it("refuses a route that belongs to another driver", async () => {
    const routeId = await releasedRoute();

    context.userRepository.user.push({
      id: "other-driver-user",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
    } as User);

    // 404 and not 403: a driver must not learn that a route id is real by
    // being told a different refusal.
    await expect(
      context.start.execute({
        userId: "other-driver-user",
        businessId: BUSINESS,
        routeId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses somebody who is not a driver at all", async () => {
    const routeId = await releasedRoute();

    await expect(
      context.start.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_DRIVER" });
  });

  it("lets the driver swap the vehicle at the yard", async () => {
    const routeId = await releasedRoute();

    context.vehicleRepository.vehicles.push({
      id: "spare-vehicle",
      license_plate: "XYZ9K88",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle);

    const started = await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
      vehicleId: "spare-vehicle",
    });

    expect(started.vehicleId).toBe("spare-vehicle");
  });

  it("refuses a swap onto a blocked vehicle", async () => {
    const routeId = await releasedRoute();

    context.vehicleRepository.vehicles.push({
      id: "blocked-vehicle",
      license_plate: "BLK0K00",
      status: "BLOCKED",
      businessId: BUSINESS,
    } as Vehicle);

    await expect(
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId,
        vehicleId: "blocked-vehicle",
      }),
    ).rejects.toMatchObject({ code: "ROUTE_VEHICLE_UNAVAILABLE" });
  });

  it("accepts the vehicle the route already had, confirmed again", async () => {
    // The app sends the vehicle it is showing. That must not read as a swap
    // onto a vehicle "already in use" — by this very route.
    const routeId = await releasedRoute();

    const started = await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
      vehicleId: VEHICLE,
    });

    expect(started.vehicleId).toBe(VEHICLE);
  });

  it("refuses a second route leaving on the same vehicle", async () => {
    // R6, and the reason it is a partial unique index in Postgres: the truck
    // is on one road.
    const first = await releasedRoute();

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: first,
    });

    const secondDelivery = await seedDelivery(context);

    const second = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: TOMORROW,
      deliveryIds: [secondDelivery],
    });

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: second.id,
    });

    context.userRepository.user.push({
      id: "second-driver-user",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
    } as User);

    await expect(
      context.start.execute({
        userId: "second-driver-user",
        businessId: BUSINESS,
        routeId: second.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_VEHICLE_BUSY" });
  });

  it("still allows PLANNING a second route on the same vehicle", async () => {
    // Deliberate: a dispatcher lays out the whole week. Only the departure is
    // exclusive.
    const first = await releasedRoute();

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: first,
    });

    const second = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: TOMORROW,
      deliveryIds: [],
    });

    expect(second.vehicleId).toBe(VEHICLE);
  });
});

describe("two surfaces acting on the same route at once", () => {
  it("lets the first departure land and refuses the second with 409", async () => {
    // The driver taps twice, or the offline queue resends. Both read RELEASED,
    // both pass the state machine, and one of them is about to start a route
    // that already left.
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    const depart = () =>
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId: route.id,
      });

    const [first, second] = await Promise.allSettled([depart(), depart()]);

    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);

    const loser = [first, second].find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;

    expect(loser.reason).toMatchObject({
      statusCode: 409,
      code: "ROUTE_STATUS_CONFLICT",
    });
  });

  it("refuses the dispatcher cancelling while the driver departs", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    await Promise.allSettled([
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId: route.id,
      }),
      context.cancel.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        reason: "Cliente cancelou o pedido",
      }),
    ]);

    const stored = context.routeRepository.routes[0];

    // Deliberately NOT "exactly one of them failed". Both succeeding is a
    // correct outcome and a real one: the driver left, and the dispatcher then
    // cancelled the route out from under them, which the state machine allows
    // on purpose — a truck that breaks down after leaving has to be callable
    // off. Asserting one rejection would be asserting a particular
    // interleaving, and a test that pins the scheduler breaks on any refactor
    // that adds an await without changing a single rule.
    //
    // What must hold whatever the order is that the route lands on ONE
    // coherent state.
    expect(["IN_PROGRESS", "CANCELLED"]).toContain(stored.status);

    if (stored.status === "CANCELLED") {
      expect(stored.cancellation_reason).toBe("Cliente cancelou o pedido");
    } else {
      // A route still running was never cancelled, so it carries no reason.
      expect(stored.cancellation_reason).toBeNull();
      expect(stored.started_at).not.toBeNull();
    }
  });

  it("lets exactly one of two writes from the SAME read land", async () => {
    // The guarantee the test above cannot express, at the layer that gives it:
    // both callers validated against RELEASED, so both send it as the expected
    // status. The `where` matches for one of them and matches nothing for the
    // other — one passes, one loses, and neither leaves a half-written route.
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    const [departure, cancellation] = await Promise.allSettled([
      context.routeRepository.transitionRoute(route.id, BUSINESS, {
        expectedStatus: "RELEASED",
        status: "IN_PROGRESS",
        started_at: new Date(),
      }),
      context.routeRepository.transitionRoute(route.id, BUSINESS, {
        expectedStatus: "RELEASED",
        status: "CANCELLED",
        cancellation_reason: "Cliente cancelou o pedido",
      }),
    ]);

    expect([departure.status, cancellation.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);

    const stored = context.routeRepository.routes[0];

    // Never a cancelled route stamped with a departure time, or the reverse.
    if (stored.status === "IN_PROGRESS") {
      expect(stored.cancellation_reason).toBeNull();
    } else {
      expect(stored.status).toBe("CANCELLED");
      expect(stored.started_at).toBeNull();
    }
  });
});

describe("cancelling a route", () => {
  it("requires a reason", async () => {
    // Cancelling a route that already left throws away a driver's morning,
    // and the only way anyone reconstructs why is if it was said at the time.
    const route = await createRoute(context, []);

    await expect(
      context.cancel.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "ROUTE_CANCELLATION_REASON_REQUIRED" });
  });

  it("records the reason", async () => {
    const route = await createRoute(context, []);

    const cancelled = await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      reason: "Veículo quebrou",
    });

    expect(cancelled.cancellation_reason).toBe("Veículo quebrou");
  });

  it("releases the deliveries it was holding", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      reason: "Remarcada",
    });

    const mirrored = context.routeRepository.deliveries.find(
      (entry) => entry.id === delivery,
    );

    expect(mirrored?.driverId).toBeNull();
    expect(mirrored?.vehicleId).toBeNull();
  });

  it("cancels the open stops, which is what frees the delivery", async () => {
    // A stop left PENDING on a cancelled route would keep its delivery out of
    // every future route, invisibly, forever.
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      reason: "Remarcada",
    });

    expect(context.routeRepository.stops[0].status).toBe("CANCELLED");
  });

  it("cannot cancel a route twice", async () => {
    const route = await createRoute(context, []);

    const cancel = () =>
      context.cancel.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        reason: "Remarcada",
      });

    await cancel();

    await expect(cancel()).rejects.toMatchObject({
      code: "INVALID_ROUTE_TRANSITION",
    });
  });
});

describe("editing the plan", () => {
  async function plannedRoute(): Promise<string> {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    return route.id;
  }

  const edit = (routeId: string) =>
    context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      name: "Zona Sul — manhã",
    });

  it("edits a route that is still being planned", async () => {
    const routeId = await plannedRoute();

    const updated = await edit(routeId);

    expect(updated.name).toBe("Zona Sul — manhã");
  });

  it("still edits one that is released but has not left", async () => {
    // The dispatcher fixing a name or a window after handing the route over
    // is normal; nothing has been executed yet.
    const routeId = await plannedRoute();

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
    });

    const updated = await edit(routeId);

    expect(updated.name).toBe("Zona Sul — manhã");
    expect(updated.status).toBe("RELEASED");
  });

  it("refuses to edit a route that already left", async () => {
    // From here the route is a record of what the driver is doing. Editing it
    // would rewrite that — silently, and after the fact.
    const routeId = await plannedRoute();

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
    });

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
    });

    await expect(edit(routeId)).rejects.toMatchObject({
      code: "ROUTE_NOT_EDITABLE",
    });

    expect(context.routeRepository.routes[0].name).toBeNull();
  });

  it("refuses to edit a cancelled route", async () => {
    const routeId = await plannedRoute();

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      reason: "Cliente remarcou",
    });

    await expect(edit(routeId)).rejects.toMatchObject({
      code: "ROUTE_NOT_EDITABLE",
    });
  });

  it("refuses the repository write too, not only the use case", async () => {
    // The state guard is in the `where`, so a caller that skipped the use case
    // — a future controller, a job, an import script — is refused by the data
    // layer rather than silently rewriting a route that ran.
    const routeId = await plannedRoute();

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
    });

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
    });

    await expect(
      context.routeRepository.updateRoute(routeId, BUSINESS, {
        name: "por fora do use case",
      }),
    ).rejects.toThrow();

    expect(context.routeRepository.routes[0].name).toBeNull();
  });

  it("moves the shadow when the driver changes", async () => {
    const delivery = await seedDelivery(context);
    const route = await createRoute(context, [delivery]);

    await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      driverId: OTHER_DRIVER,
    });

    const mirrored = context.routeRepository.deliveries.find(
      (entry) => entry.id === delivery,
    );

    expect(mirrored?.driverId).toBe(OTHER_DRIVER);
  });

  it("refuses to hand the route to an inactive driver", async () => {
    const routeId = await plannedRoute();

    context.driverRepository.drivers[1].status = "INACTIVE";

    await expect(
      context.update.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId,
        driverId: OTHER_DRIVER,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_DRIVER_INACTIVE" });
  });
});

describe("telling the people waiting that the truck left", () => {
  /**
   * The "saiu para entrega" message, published with the departure rather than
   * after it: a route departs once, and there is no second chance to publish.
   *
   * The other half is the silence. Most deliveries carry neither an e-mail nor
   * a phone for the person receiving them, and a forty-stop route that queued
   * forty rows for forty people who cannot be reached would be forty rows
   * claimed, expanded into nothing and discarded, every day, forever.
   */
  function dispatched() {
    return published.filter((event) => event.topic === "delivery.dispatched");
  }

  async function releasedRouteWith(
    overrides: Array<Partial<CreateDeliveryProps>>,
  ): Promise<string> {
    const deliveryIds: string[] = [];

    for (const override of overrides) {
      deliveryIds.push(await seedDelivery(context, override));
    }

    const route = await createRoute(context, deliveryIds);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    published.length = 0;

    return route.id;
  }

  it("publishes one message per stop that has somebody to tell", async () => {
    const routeId = await releasedRouteWith([
      { recipient_email: "cliente@exemplo.com.br", invoice_number: "111" },
      { recipient_telephone: "11999999999", invoice_number: "222" },
    ]);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
    });

    expect(dispatched()).toHaveLength(2);

    expect(dispatched()[0].payload).toMatchObject({
      recipientEmail: "cliente@exemplo.com.br",
      invoiceNumber: "111",
      businessId: BUSINESS,
    });
  });

  it("queues nothing for a stop nobody can be told about", async () => {
    const routeId = await releasedRouteWith([
      {},
      { recipient_email: "cliente@exemplo.com.br" },
      {},
    ]);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId,
    });

    expect(dispatched()).toHaveLength(1);
  });

  it("publishes nothing at all when the departure was refused", async () => {
    // The route never left, so nobody's phone should have been told it did.
    const delivery = await seedDelivery(context, {
      recipient_email: "cliente@exemplo.com.br",
    });

    const route = await createRoute(context, [delivery]);

    published.length = 0;

    await expect(
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROUTE_TRANSITION" });

    expect(dispatched()).toEqual([]);
  });
});
