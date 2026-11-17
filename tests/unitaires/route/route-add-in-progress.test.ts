import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { AppError } from "@/shared/errors/AppError";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import { withoutCreationLine } from "../../support/status-trail";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Adding to a route that already left, and "Reentregar" (K12, decision D30).
 *
 * "Adicionar entregas" was disabled on a running route: a delivery that
 * turned up mid-morning waited for tomorrow, or got a route of its own. A
 * running route takes new stops now, at the end of its order: the load goes
 * on the street in the same commit (IN_TRANSIT, as the departure does it),
 * the customer is told it left, the plan moves a version and the driver is
 * told. "Reentregar" puts a failed delivery back (FAILED → PENDING, with the
 * reason the panel always asks for) and on the route in one transaction.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const heard = vi.hoisted(() => ({
  driver: [] as Array<{ userId: string | null; event: unknown }>,
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: () => undefined,
  sendRouteEventToDriver: (userId: string | null, event: unknown) => {
    heard.driver.push({ userId, event });
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-000000000a0b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-000000000a0c";
const DISPATCHER = "018f0000-0000-7000-8000-000000000aaa";
const DRIVER_USER = "018f0000-0000-7000-8000-000000000aab";
const DRIVER = "018f0000-0000-7000-8000-000000000ad1";
const VEHICLE = "018f0000-0000-7000-8000-000000000ae1";
const SHIPPER = "018f0000-0000-7000-8000-000000000af1";
const REASON = "018f0000-0000-7000-8000-000000000a51";
const RETIRED_REASON = "018f0000-0000-7000-8000-000000000a52";
const FOREIGN_REASON = "018f0000-0000-7000-8000-000000000a53";

function makeContext() {
  const published: Array<{ topic: string; aggregateId: string }> = [];

  const outbox = {
    publish: async (
      _tx: unknown,
      event: { topic: string; aggregateId: string },
    ) => {
      published.push({ topic: event.topic, aggregateId: event.aggregateId });
    },
  } as unknown as OutboxService;

  const notifications = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  const webhooks = new InMemoryWebhookFanOutService().asService();

  const deliveries = new InMemoryDeliveryRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const users = new InMemoryUserRepository();
  const reasons = new InMemoryStatusChangeReasonRepository();

  const routes = new InMemoryRouteRepository(
    deliveries.deliveries,
    vehicles.vehicles,
    drivers.drivers,
  );

  deliveries.routeStops = routes.stops;

  users.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  drivers.drivers.push({
    id: DRIVER,
    name: "João",
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    status: "ACTIVE",
    driverId: DRIVER,
    businessId: BUSINESS,
  } as Vehicle);

  reasons.statusChangeReasons.push(
    {
      id: REASON,
      name: "Cliente pediu nova tentativa",
      description: null,
      is_active: true,
      businessId: BUSINESS,
    },
    {
      id: RETIRED_REASON,
      name: "Antigo",
      description: null,
      is_active: false,
      businessId: BUSINESS,
    },
    {
      id: FOREIGN_REASON,
      name: "De outra empresa",
      description: null,
      is_active: true,
      businessId: OTHER_BUSINESS,
    },
  );

  return {
    published,
    deliveries,
    routes,
    create: new CreateRouteUseCase(
      routes,
      users,
      deliveries,
      drivers,
      vehicles,
      notifications,
      webhooks,
    ),
    release: new ReleaseRouteUseCase(
      routes,
      users,
      drivers,
      vehicles,
      notifications,
      outbox,
      webhooks,
    ),
    start: new StartRouteUseCase(
      routes,
      users,
      vehicles,
      notifications,
      outbox,
      webhooks,
    ),
    addStops: new AddRouteStopsUseCase(
      routes,
      users,
      deliveries,
      notifications,
      webhooks,
      reasons,
      outbox,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  heard.driver.length = 0;
  context = makeContext();
});

async function seedDelivery(
  overrides: Partial<CreateDeliveryProps> = {},
): Promise<string> {
  const created = await context.deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatária",
    recipient_telephone: "11999990000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...overrides,
  } as CreateDeliveryProps);

  return created.id!;
}

async function runningRoute(): Promise<string> {
  const route = await context.create.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
    deliveryIds: [await seedDelivery()],
  });

  await context.release.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    routeId: route.id,
  });

  await context.start.execute({
    userId: DRIVER_USER,
    businessId: BUSINESS,
    routeId: route.id,
  });

  context.published.length = 0;
  heard.driver.length = 0;

  return route.id;
}

const delivery = (id: string) =>
  context.deliveries.deliveries.find((entry) => entry.id === id)!;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    throw error;
  }

  throw new Error("expected a refusal");
}

describe("adding a delivery to a route that already left", () => {
  it("puts it on the street at the end of the order and tells the driver and the customer", async () => {
    const routeId = await runningRoute();
    const late = await seedDelivery({ recipient_name: "Chegou depois" });

    const before = context.routes.routes.find(
      (r) => r.id === routeId,
    )!.plan_version;

    const result = await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [late],
    });

    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]).toMatchObject({ status: "PENDING", sequence: 20 });
    expect(result.planVersion).toBe(before + 1);

    // On the truck, like the route's own load at the departure: arrival and
    // proof require IN_TRANSIT.
    expect(delivery(late)).toMatchObject({
      status: "IN_TRANSIT",
      driverId: DRIVER,
      vehicleId: VEHICLE,
    });

    expect(context.published).toEqual([
      { topic: "delivery.dispatched", aggregateId: late },
    ]);

    // The driver's phone hears the new plan, as on a released route.
    expect(heard.driver).toEqual([
      {
        userId: DRIVER_USER,
        event: expect.objectContaining({
          type: "route.stops_changed",
          routeId,
          planVersion: before + 1,
        }),
      },
    ]);
  });

  it("tells no customer who left no contact", async () => {
    const routeId = await runningRoute();
    const late = await seedDelivery({ recipient_telephone: null });

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [late],
    });

    expect(context.published).toEqual([]);
  });

  it("refuses a route that has ended", async () => {
    const routeId = await runningRoute();

    context.routes.routes.find((r) => r.id === routeId)!.status = "COMPLETED";

    expect(
      await refusal(
        context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId,
          deliveryIds: [await seedDelivery()],
        }),
      ),
    ).toBe("409 ROUTE_STATUS_CONFLICT");
  });
});

describe("Reentregar", () => {
  async function failedDelivery(): Promise<string> {
    const id = await seedDelivery({ recipient_name: "Ausente ontem" });

    delivery(id).status = "FAILED";

    return id;
  }

  it("puts a failed delivery back with the reason and on the running route, in one go", async () => {
    const routeId = await runningRoute();
    const failed = await failedDelivery();

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [failed],
      redelivery: { reasonId: REASON, note: "Cliente ligou" },
    });

    expect(delivery(failed)).toMatchObject({
      status: "IN_TRANSIT",
      driverId: DRIVER,
    });

    expect(
      withoutCreationLine(context.deliveries.events).filter(
        (event) =>
          event.deliveryId === failed && event.type === "STATUS_CHANGE",
      ),
    ).toEqual([
      expect.objectContaining({
        status_from: "FAILED",
        status_to: "PENDING",
        reasonId: REASON,
        reportedById: DISPATCHER,
        note: "Cliente ligou",
      }),
    ]);
  });

  it("still refuses a failed delivery sent without the reason", async () => {
    const routeId = await runningRoute();
    const failed = await failedDelivery();

    expect(
      await refusal(
        context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId,
          deliveryIds: [failed],
        }),
      ),
    ).toBe("400 DELIVERY_NOT_ROUTABLE");
    expect(delivery(failed).status).toBe("FAILED");
  });

  it("refuses another company's reason like a missing one, and a retired one, moving nothing", async () => {
    const routeId = await runningRoute();
    const failed = await failedDelivery();

    const send = (reasonId: string) =>
      context.addStops.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        routeId,
        deliveryIds: [failed],
        redelivery: { reasonId },
      });

    expect(await refusal(send(FOREIGN_REASON))).toBe(
      "404 STATUS_CHANGE_REASON_NOT_FOUND",
    );
    expect(await refusal(send(RETIRED_REASON))).toBe(
      "400 STATUS_CHANGE_REASON_INACTIVE",
    );
    expect(delivery(failed).status).toBe("FAILED");
    expect(context.routes.stops.some((s) => s.deliveryId === failed)).toBe(
      false,
    );
  });

  // F2-06: the only line is the route's own, the SYSTEM departure.
  it("adds a pending delivery sent along without a redelivery line", async () => {
    const routeId = await runningRoute();
    const pending = await seedDelivery();

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [pending],
      redelivery: { reasonId: REASON },
    });

    expect(
      withoutCreationLine(context.deliveries.events).filter(
        (event) =>
          event.deliveryId === pending && event.type === "STATUS_CHANGE",
      ),
    ).toEqual([]);
    expect(
      context.routes.events.filter(
        (event) =>
          event.deliveryId === pending && event.type === "STATUS_CHANGE",
      ),
    ).toEqual([
      expect.objectContaining({
        actor: "SYSTEM",
        status_from: "PENDING",
        status_to: "IN_TRANSIT",
        routeId,
      }),
    ]);
    expect(delivery(pending).status).toBe("IN_TRANSIT");
  });
});
