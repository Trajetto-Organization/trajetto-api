import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { RemoveRouteStopUseCase } from "@/modules/route/usecases/remove-route-stop/remove-route-stop-usecase";
import { RemoveRouteStopsUseCase } from "@/modules/route/usecases/remove-route-stops/remove-route-stops-usecase";
import { ReorderRouteStopsUseCase } from "@/modules/route/usecases/reorder-route-stops/reorder-route-stops-usecase";
import { AssignmentPreviewUseCase } from "@/modules/route/usecases/assignment-preview/assignment-preview-usecase";
import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
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
import type { Route } from "@/modules/route/dtos/route-dto";

/**
 * The route's plan through the use cases (decisions 1.3, 1.4, 6.5), the
 * activity status they record (FLEET-ACT-1), one running route per driver
 * (FLEET-ASSIGN-3) and the assignment preview (FLEET-ASSIGN-2).
 *
 * The real use cases over the in-memory repositories; the transaction is a
 * passthrough, as in every route unit suite. What only Postgres proves (the
 * lock, the Int column) is in tests/E2E/route-plan-http.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER = "018f0000-0000-7000-8000-0000000000d9";

const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const OTHER_VEHICLE = "018f0000-0000-7000-8000-0000000000e2";
const FOREIGN_VEHICLE = "018f0000-0000-7000-8000-0000000000e9";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const DAY_17 = new Date("2026-09-17T00:00:00.000Z");

interface RecordedActivity {
  description: string;
  status: string;
}

function makeContext() {
  const activities: RecordedActivity[] = [];

  const notificationService = {
    createActivityIfEnabled: async (activity: RecordedActivity) => {
      activities.push({ description: activity.description, status: activity.status });
    },
  } as unknown as NotificationService;

  const outboxStub = {
    publish: async () => undefined,
  } as unknown as OutboxService;

  const webhooks = new InMemoryWebhookFanOutService();

  const deliveryRepository = new InMemoryDeliveryRepository();
  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  // One store for routes and deliveries, and the vehicle and driver rows the
  // preview reads — in Postgres they are one database.
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
    vehicleRepository.vehicles,
    driverRepository.drivers,
  );

  deliveryRepository.routeStops = routeRepository.stops;

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
    { id: DRIVER, name: "João", status: "ACTIVE", businessId: BUSINESS } as Driver,
    { id: OTHER_DRIVER, name: "Maria", status: "ACTIVE", businessId: BUSINESS } as Driver,
    {
      id: FOREIGN_DRIVER,
      name: "De fora",
      status: "ACTIVE",
      businessId: OTHER_BUSINESS,
    } as Driver,
  );

  vehicleRepository.vehicles.push(
    {
      id: VEHICLE,
      license_plate: "ABC1D23",
      description: "Caminhão",
      status: "ACTIVE",
      driverId: DRIVER,
      businessId: BUSINESS,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    } as Vehicle,
    {
      id: OTHER_VEHICLE,
      license_plate: "XYZ9K87",
      description: "Van",
      status: "ACTIVE",
      driverId: OTHER_DRIVER,
      businessId: BUSINESS,
      created_at: new Date("2026-01-02T00:00:00.000Z"),
    } as Vehicle,
    {
      id: FOREIGN_VEHICLE,
      license_plate: "FOR0E11",
      description: "De fora",
      status: "ACTIVE",
      driverId: null,
      businessId: OTHER_BUSINESS,
    } as Vehicle,
  );

  const create = new CreateRouteUseCase(
    routeRepository,
    userRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    notificationService,
    webhooks.asService(),
  );

  const release = new ReleaseRouteUseCase(
    routeRepository,
    userRepository,
    driverRepository,
    notificationService,
    outboxStub,
    webhooks.asService(),
  );

  const update = new UpdateRouteUseCase(
    routeRepository,
    userRepository,
    driverRepository,
    vehicleRepository,
    notificationService,
    webhooks.asService(),
  );

  const cancel = new CancelRouteUseCase(
    routeRepository,
    userRepository,
    notificationService,
    outboxStub,
    webhooks.asService(),
  );

  return {
    activities,
    routeRepository,
    deliveryRepository,
    vehicleRepository,
    create,
    release,
    cancel,
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
      outboxStub,
      webhooks.asService(),
    ),
    update,
    addStops: new AddRouteStopsUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      notificationService,
      webhooks.asService(),
    ),
    removeStop: new RemoveRouteStopUseCase(
      new RemoveRouteStopsUseCase(
        routeRepository,
        userRepository,
        notificationService,
      ),
    ),
    reorder: new ReorderRouteStopsUseCase(
      routeRepository,
      userRepository,
      notificationService,
    ),
    assign: new AssignDeliveriesUseCase(
      userRepository,
      routeRepository,
      create,
      release,
      cancel,
      update,
    ),
    preview: new AssignmentPreviewUseCase(routeRepository, userRepository),
  };
}

type Context = ReturnType<typeof makeContext>;

async function seedDelivery(context: Context): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatária",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

let context: Context;

beforeEach(() => {
  context = makeContext();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("planning a route's window (create)", () => {
  it("accepts an evening departure of the route's day in the company's zone", async () => {
    const route = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: DAY_17,
      // 22:30 of the 17th in São Paulo, 01:30Z of the 18th.
      planned_departure_at: new Date("2026-09-18T01:30:00.000Z"),
      destination: "CD Cajamar",
    });

    expect(route.destination).toBe("CD Cajamar");
    expect(route.planned_departure_at?.toISOString()).toBe("2026-09-18T01:30:00.000Z");
  });

  it("refuses a departure that is another day in the company's zone", async () => {
    // Red before: nothing checked the window. In Manaus (UTC-4) 01:30Z of
    // the 18th is 21:30 of the 17th; the company zone decides, not UTC.
    context.routeRepository.timeZones[BUSINESS] = "America/Manaus";

    await expect(
      context.create.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: DRIVER,
        scheduled_date: DAY_17,
        planned_departure_at: new Date("2026-09-17T03:30:00.000Z"), // 23:30 of the 16th
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ROUTE_PLAN_INVALID",
      message: "A saída prevista deve ser no dia da rota.",
    });

    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("refuses a return before the departure", async () => {
    await expect(
      context.create.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: DRIVER,
        scheduled_date: DAY_17,
        planned_departure_at: new Date("2026-09-17T15:00:00.000Z"),
        planned_arrival_at: new Date("2026-09-17T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "ROUTE_PLAN_INVALID",
      message: "O retorno previsto deve ser igual ou posterior à saída prevista.",
    });
  });
});

describe("editing a route's window (update)", () => {
  const plannedRoute = () =>
    context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: DAY_17,
      planned_departure_at: new Date("2026-09-17T11:00:00.000Z"),
      planned_arrival_at: new Date("2026-09-17T20:00:00.000Z"),
    });

  it("re-reads a new driver under the row's lock and refuses one deactivated since", async () => {
    const route = await plannedRoute();

    // The driver module's row committed INACTIVE after the use case's own
    // read: the twin's rows are what the locked re-read sees.
    context.routeRepository.drivers = context.routeRepository.drivers.map((entry) =>
      entry.id === OTHER_DRIVER ? { ...entry, status: "INACTIVE" } : entry,
    );

    await expect(
      context.update.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        driverId: OTHER_DRIVER,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_DRIVER_INACTIVE" });

    expect(
      context.routeRepository.routes.find((entry) => entry.id === route.id)?.driverId,
    ).toBe(DRIVER);
  });

  it("judges a partial edit against what is stored", async () => {
    const route = await plannedRoute();

    // Only the day moves: the stored departure is now on another day.
    await expect(
      context.update.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        scheduled_date: new Date("2026-09-18T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "ROUTE_PLAN_INVALID" });

    // Only the return moves, to before the stored departure.
    await expect(
      context.update.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId: route.id,
        planned_arrival_at: new Date("2026-09-17T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      message: "O retorno previsto deve ser igual ou posterior à saída prevista.",
    });

    // Moving the day WITH the departure is fine.
    const moved = await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      scheduled_date: new Date("2026-09-18T00:00:00.000Z"),
      planned_departure_at: new Date("2026-09-18T11:00:00.000Z"),
      planned_arrival_at: null,
    });

    expect(moved.scheduled_date.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(moved.planned_arrival_at).toBeNull();
  });

  it("does not refuse a rename over a window stored before the rule", async () => {
    const route = await plannedRoute();

    // A legacy row: departure on another day than the route.
    context.routeRepository.routes[0].planned_departure_at = new Date(
      "2026-09-10T11:00:00.000Z",
    );

    const renamed = await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      name: "Zona Sul",
      destination: "Zona Leste",
    });

    expect(renamed.name).toBe("Zona Sul");
    expect(renamed.destination).toBe("Zona Leste");
  });

  it("clears the destination with null and keeps it when absent", async () => {
    const route = await plannedRoute();

    await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      destination: "CD Cajamar",
    });

    const kept = await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      name: "Outra",
    });

    expect(kept.destination).toBe("CD Cajamar");

    const cleared = await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      destination: null,
    });

    expect(cleared.destination).toBeNull();
  });
});

describe("the activity status the route writes (FLEET-ACT-1)", () => {
  it("records the pt-BR label for edits and stop changes, never the enum", async () => {
    // Red before: add/remove/reorder/update stored `PLANNED`, which is what
    // the Activities screen showed.
    const first = await seedDelivery(context);
    const second = await seedDelivery(context);

    const route = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
    });

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      deliveryIds: [first, second],
    });

    const stops = context.routeRepository.stops.filter((stop) => stop.routeId === route.id);

    await context.reorder.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      orderedStopIds: [stops[1].id, stops[0].id],
    });

    await context.removeStop.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      stopId: stops[0].id,
    });

    await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      name: "Zona Sul",
    });

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    await context.update.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      name: "Zona Norte",
    });

    const statuses = context.activities.map((activity) => activity.status);

    expect(statuses).toEqual([
      "Planejada", // created
      "Planejada", // stops added
      "Planejada", // reordered
      "Planejada", // stop removed
      "Planejada", // edited
      "Liberada", // released
      "Liberada", // edited while released
    ]);

    for (const status of statuses) {
      expect(status).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("the batch assignment's plan", () => {
  const assign = (overrides: Record<string, unknown> = {}) =>
    seedDelivery(context).then((delivery) =>
      context.assign.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        deliveryIds: [delivery],
        driverId: DRIVER,
        vehicleId: VEHICLE,
        ...overrides,
      }),
    );

  it("schedules today in the COMPANY's zone and names it on its clock", async () => {
    // 23:30 of the 17th in Manaus = 00:30 of the 18th in São Paulo = 03:30Z.
    // Red before: startOfToday() was the process's midnight — the 18th both
    // on this machine (São Paulo) and in the container (UTC).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T03:30:00.000Z"));

    context.routeRepository.timeZones[BUSINESS] = "America/Manaus";

    const { routeId } = await assign();

    const route = context.routeRepository.routes.find((entry) => entry.id === routeId)!;

    expect(route.scheduled_date.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(route.name).toBe("Designação 17/09 23:30");
  });

  it("creates the route with the day, destination and window it was given", async () => {
    // Red before: the schema and the use case dropped all four.
    const { routeId } = await assign({
      scheduled_date: new Date("2026-09-20T00:00:00.000Z"),
      destination: "Zona Leste",
      planned_departure_at: new Date("2026-09-20T11:00:00.000Z"),
      planned_arrival_at: new Date("2026-09-20T21:00:00.000Z"),
    });

    const route = context.routeRepository.routes.find((entry) => entry.id === routeId)!;

    expect(route.status).toBe("RELEASED");
    expect(route.scheduled_date.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(route.destination).toBe("Zona Leste");
    expect(route.planned_departure_at?.toISOString()).toBe("2026-09-20T11:00:00.000Z");
    expect(route.planned_arrival_at?.toISOString()).toBe("2026-09-20T21:00:00.000Z");
  });

  it("refuses a departure off the route's day before touching anything", async () => {
    const delivery = await seedDelivery(context);

    await expect(
      context.assign.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        deliveryIds: [delivery],
        driverId: DRIVER,
        vehicleId: VEHICLE,
        scheduled_date: new Date("2026-09-20T00:00:00.000Z"),
        planned_departure_at: new Date("2026-09-21T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "ROUTE_PLAN_INVALID" });

    expect(context.routeRepository.routes).toHaveLength(0);
  });

  it("applies a corrected plan when the same selection is confirmed again", async () => {
    const delivery = await seedDelivery(context);

    const first = await context.assign.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryIds: [delivery],
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date("2026-09-20T00:00:00.000Z"),
      destination: "Zona Leste",
      planned_departure_at: new Date("2026-09-20T11:00:00.000Z"),
    });

    // Same documents, driver and truck; the dispatcher fixed the plan.
    const second = await context.assign.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryIds: [delivery],
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date("2026-09-20T00:00:00.000Z"),
      destination: "CD Cajamar",
      planned_departure_at: new Date("2026-09-20T12:30:00.000Z"),
      planned_arrival_at: new Date("2026-09-20T20:00:00.000Z"),
    });

    // Still one route, released once; red before: the resend answered with
    // it and dropped the new destination and window.
    expect(second.routeId).toBe(first.routeId);
    expect(context.routeRepository.routes).toHaveLength(1);

    const route = context.routeRepository.routes[0];

    expect(route.status).toBe("RELEASED");
    expect(route.destination).toBe("CD Cajamar");
    expect(route.planned_departure_at?.toISOString()).toBe("2026-09-20T12:30:00.000Z");
    expect(route.planned_arrival_at?.toISOString()).toBe("2026-09-20T20:00:00.000Z");
    expect(context.activities[context.activities.length - 1]).toEqual({
      description: "Rota 1 editada",
      status: "Liberada",
    });
  });

  it("keeps a true resend a no-op, and judges a corrected plan by the same rules", async () => {
    const delivery = await seedDelivery(context);

    const asked = {
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryIds: [delivery],
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date("2026-09-20T00:00:00.000Z"),
      planned_departure_at: new Date("2026-09-20T11:00:00.000Z"),
    };

    await context.assign.execute(asked);

    const writes = context.activities.length;

    await context.assign.execute(asked);

    expect(context.activities).toHaveLength(writes);

    // Moving the day alone leaves the stored departure on another day.
    await expect(
      context.assign.execute({ ...asked, scheduled_date: new Date("2026-09-21T00:00:00.000Z") }),
    ).rejects.toMatchObject({ code: "ROUTE_PLAN_INVALID" });

    expect(context.routeRepository.routes[0].scheduled_date.toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
  });
});

describe("one route on the street per driver (FLEET-ASSIGN-3)", () => {
  async function releasedRoute(vehicleId: string): Promise<Route> {
    const delivery = await seedDelivery(context);

    const route = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId,
      scheduled_date: DAY_17,
      deliveryIds: [delivery],
    });

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    return route;
  }

  it("refuses the second departure while the first route runs, naming it", async () => {
    // Red before: two released routes on two trucks both left.
    const first = await releasedRoute(VEHICLE);
    const second = await releasedRoute(OTHER_VEHICLE);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: first.id,
    });

    await expect(
      context.start.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        routeId: second.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ROUTE_DRIVER_BUSY",
      message: expect.stringContaining(`Rota ${first.code}`),
    });

    const stillReleased = context.routeRepository.routes.find(
      (route) => route.id === second.id,
    );

    expect(stillReleased?.status).toBe("RELEASED");
  });

  it("keeps the resend of the running route a success", async () => {
    const first = await releasedRoute(VEHICLE);

    await context.start.execute({ userId: DRIVER_USER, businessId: BUSINESS, routeId: first.id });

    const again = await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: first.id,
    });

    expect(again.status).toBe("IN_PROGRESS");
  });

  it("lets the next route leave once the first one ended", async () => {
    const first = await releasedRoute(VEHICLE);
    const second = await releasedRoute(OTHER_VEHICLE);

    await context.start.execute({ userId: DRIVER_USER, businessId: BUSINESS, routeId: first.id });

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: first.id,
      reason: "Caminhão quebrou",
    });

    const started = await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: second.id,
    });

    expect(started.status).toBe("IN_PROGRESS");
  });
});

describe("which route is 'the' driver's route on a tie", () => {
  const seedRoute = (id: string, status: Route["status"], createdAt: string): Route => {
    const route = {
      id,
      code: context.routeRepository.routes.length + 1,
      name: null,
      status,
      scheduled_date: DAY_17,
      destination: null,
      planned_departure_at: null,
      planned_arrival_at: null,
      started_at: status === "IN_PROGRESS" ? new Date(createdAt) : null,
      completed_at: null,
      cancellation_reason: null,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: null,
      importId: null,
      plan_version: 0,
      released_at: null,
      client_submission_id: null,
      created_at: new Date(createdAt),
      updated_at: new Date(createdAt),
    } satisfies Route;

    context.routeRepository.routes.push(route);

    return route;
  };

  it("breaks a same-day tie by creation, then id, like the real query", async () => {
    // The newer row sits FIRST in the store. Red before: the fake answered
    // insertion order, the real query an arbitrary one.
    seedRoute("b-newer", "IN_PROGRESS", "2026-09-17T10:00:00.000Z");
    seedRoute("a-older", "IN_PROGRESS", "2026-09-17T09:00:00.000Z");

    expect((await context.routeRepository.findDriverRoute(BUSINESS, DRIVER))?.id).toBe(
      "a-older",
    );
    expect(
      (await context.routeRepository.findActiveRouteForDriver(BUSINESS, DRIVER))?.id,
    ).toBe("a-older");
  });

  it("still prefers the running route over a released one", async () => {
    seedRoute("released", "RELEASED", "2026-09-17T08:00:00.000Z");
    seedRoute("running", "IN_PROGRESS", "2026-09-17T09:00:00.000Z");

    expect((await context.routeRepository.findDriverRoute(BUSINESS, DRIVER))?.id).toBe(
      "running",
    );
  });
});

describe("the assignment preview (FLEET-ASSIGN-2)", () => {
  it("suggests the driver's only vehicle and says who is responsible", async () => {
    const result = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: DAY_17,
    });

    expect(result.suggestedVehicleId).toBe(VEHICLE);
    expect(result.responsibleVehicles.map((vehicle) => vehicle.license_plate)).toEqual([
      "ABC1D23",
    ]);
    expect(result.scheduled_date).toBe("2026-09-17");
    expect(result.warnings).toEqual([]);
  });

  it("warns about another driver's vehicle without refusing it", async () => {
    const result = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: OTHER_VEHICLE,
      scheduled_date: DAY_17,
    });

    expect(result.vehicle?.responsible).toEqual({ id: OTHER_DRIVER, name: "Maria" });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "VEHICLE_OTHER_RESPONSIBLE",
    ]);
  });

  it("warns about the vehicle on the street and the driver's route that day", async () => {
    const delivery = await seedDelivery(context);

    // Maria's route is out with the truck João would take.
    const running = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: OTHER_DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
      deliveryIds: [delivery],
    });

    await context.release.execute({ userId: DISPATCHER, businessId: BUSINESS, routeId: running.id });
    context.routeRepository.routes.find((route) => route.id === running.id)!.status =
      "IN_PROGRESS";

    // João already has a planned route that day.
    const planned = await context.create.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: DAY_17,
    });

    const result = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
    });

    expect(result.warnings.map((warning) => warning.message)).toEqual([
      `João já tem a Rota ${planned.code} para este dia.`,
      `O veículo ABC1D23 está em rota agora (Rota ${running.code}, com Maria); ele só pode sair de novo quando essa rota terminar.`,
    ]);

    // Editing that same planned route: it is not a conflict with itself.
    const editing = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      scheduled_date: DAY_17,
      excludeRouteId: planned.id,
    });

    expect(editing.warnings).toEqual([]);
  });

  it("reads a driver or vehicle of another company as absent", async () => {
    await expect(
      context.preview.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: FOREIGN_DRIVER,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DRIVER_NOT_FOUND" });

    await expect(
      context.preview.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: DRIVER,
        vehicleId: FOREIGN_VEHICLE,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VEHICLE_NOT_FOUND" });
  });

  it("is the dispatcher's read: a driver's token is refused", async () => {
    await expect(
      context.preview.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        driverId: DRIVER,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "DRIVER_CANNOT_MANAGE_DELIVERIES" });
  });

  it("does not warn about the released route the selection empties", async () => {
    const delivery = await seedDelivery(context);

    // Assigned yesterday evening to João and his truck, for the 17th.
    const { routeId } = await context.assign.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      deliveryIds: [delivery],
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
    });

    const code = context.routeRepository.routes.find((route) => route.id === routeId)!.code;

    // Without the selection the route is a real booking of the day.
    const plain = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
    });

    expect(plain.warnings.map((warning) => warning.message)).toEqual([
      `João já tem a Rota ${code} para este dia.`,
    ]);

    // Re-assigning that same selection empties (and cancels) it: no warning.
    // Red before: the dialog warned about the route the documents leave.
    const reassigning = await context.preview.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: DAY_17,
      deliveryIds: [delivery],
    });

    expect(reassigning.warnings).toEqual([]);
  });

  it("passes the fleet's facts to the warnings and keeps them off the answer (8.5)", async () => {
    const driver = context.routeRepository.drivers.find((entry) => entry.id === DRIVER)!;

    driver.cnh_category = "B";
    driver.cnh_expires_at = new Date("2026-09-01T00:00:00.000Z");

    Object.assign(context.routeRepository.vehicles.find((entry) => entry.id === VEHICLE)!, {
      required_cnh_category: "C",
      open_service_orders: [new Date("2026-09-10T15:00:00.000Z")],
      last_checklist: {
        overall_condition: "rejected",
        checklist_date: new Date("2026-09-16T15:00:00.000Z"),
      },
    });

    context.routeRepository.timeZones[BUSINESS] = "America/Manaus";

    const ask = () =>
      context.preview.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        driverId: DRIVER,
        vehicleId: VEHICLE,
        scheduled_date: DAY_17,
      });

    // Without Frotas the orders and checklists are not its operation
    // (decision 4.3); the CNH is the driver's, which Entregas has too. Red
    // before: all four, whatever the company hired.
    const withoutFleet = await ask();

    expect(withoutFleet.warnings.map((warning) => warning.code)).toEqual([
      "DRIVER_CNH_EXPIRED",
      "DRIVER_CNH_INCOMPATIBLE",
    ]);

    context.routeRepository.fleetEnabled.add(BUSINESS);

    const result = await ask();

    expect(result.timeZone).toBe("America/Manaus");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "DRIVER_CNH_EXPIRED",
      "DRIVER_CNH_INCOMPATIBLE",
      "VEHICLE_OPEN_SERVICE_ORDER",
      "VEHICLE_CHECKLIST_REJECTED",
    ]);

    // Only what the choice needs leaves the API (decision 4.7).
    expect(result.driver).toEqual({ id: DRIVER, name: "João", status: "ACTIVE" });
    expect(Object.keys(result.vehicle ?? {}).sort()).toEqual([
      "description",
      "id",
      "license_plate",
      "responsible",
      "status",
    ]);
  });
});
