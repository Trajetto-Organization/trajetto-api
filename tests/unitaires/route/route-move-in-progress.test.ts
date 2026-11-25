import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Moving deliveries onto a route that already left (K12, decision D30;
 * audit of 25/11/2026), and the vehicle lists' hint of the departure.
 *
 * add-stops onto a running route puts the load on the street in the same
 * commit and says so twice, as the departure does: `delivery.in_transit` to
 * the customers' systems and "saiu para entrega" (`delivery.dispatched`)
 * to whoever waits. move-stops — what the Entregas "Adicionar à rota" calls
 * as soon as one delivery comes from another route — went through the same
 * repository write (the deliveries did go IN_TRANSIT) and said neither. Now
 * both use cases announce through announceDepartedStops, and this suite
 * holds them to the same answer.
 *
 * The departure and the end of a route move the truck's status
 * (syncVehicleStatus), and the web trusts its vehicle lists on the promise
 * that `catalogChanged` vehicle says so; the departure now does, once,
 * after its commit, and the release (which moves no truck) does not.
 */
const heard = vi.hoisted(() => ({
  catalog: [] as Array<{ businessId: string; entity: string }>,
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: () => undefined,
  sendRouteEventToDriver: () => undefined,
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    heard.catalog.push({ businessId, entity });
  },
}));

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { MoveRouteStopsUseCase } from "@/modules/route/usecases/move-route-stops/move-route-stops-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { routeMovesVehicle } from "@/shared/vehicle/route-vehicle";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-000000000d0b";
const DISPATCHER = "018f0000-0000-7000-8000-000000000daa";
const DRIVER_USER = "018f0000-0000-7000-8000-000000000dab";
const DRIVER = "018f0000-0000-7000-8000-000000000dd1";
const VEHICLE = "018f0000-0000-7000-8000-000000000de1";
const SHIPPER = "018f0000-0000-7000-8000-000000000df1";
const DAY = new Date("2026-11-25T00:00:00.000Z");

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
  const fanOut = new InMemoryWebhookFanOutService();
  const webhooks = fanOut.asService();

  const deliveries = new InMemoryDeliveryRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const users = new InMemoryUserRepository();
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

  const cancel = new CancelRouteUseCase(
    routes,
    users,
    notifications,
    outbox,
    webhooks,
  );

  return {
    published,
    fanOut,
    deliveries,
    routes,
    vehicles,
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
      new InMemoryStatusChangeReasonRepository(),
      outbox,
    ),
    move: new MoveRouteStopsUseCase(
      routes,
      users,
      deliveries,
      cancel,
      notifications,
      webhooks,
      outbox,
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  heard.catalog.length = 0;
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

async function plannedRoute(deliveryIds: string[], vehicleId?: string) {
  return context.create.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    driverId: DRIVER,
    vehicleId,
    scheduled_date: DAY,
    deliveryIds,
  });
}

async function runningRoute(): Promise<string> {
  const route = await plannedRoute([await seedDelivery()], VEHICLE);

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
  context.fanOut.announced.length = 0;
  heard.catalog.length = 0;

  return route.id;
}

const statusOf = (id: string) =>
  context.deliveries.deliveries.find((entry) => entry.id === id)?.status;

type DeliveryPayload = { delivery_id?: string };

function inTransitIds(): Array<string | undefined> {
  const events = context.fanOut.forTopic("delivery.in_transit");

  return events.map((event) => (event.payload as DeliveryPayload).delivery_id);
}

describe("moving a delivery onto a route that already left", () => {
  it("says it left, as add-stops does: in_transit and dispatched", async () => {
    const routeId = await runningRoute();
    const late = await seedDelivery({ recipient_name: "Chegou depois" });

    await plannedRoute([late]);

    await context.move.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [late],
    });

    expect(statusOf(late)).toBe("IN_TRANSIT");
    expect(inTransitIds()).toEqual([late]);
    expect(context.published).toEqual([
      { topic: "delivery.dispatched", aggregateId: late },
    ]);
  });

  it("answers the same as add-stops for a delivery on no route", async () => {
    const routeId = await runningRoute();
    const viaAdd = await seedDelivery({ recipient_name: "Pelo add" });
    const viaMove = await seedDelivery({ recipient_name: "Pelo move" });

    await context.addStops.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [viaAdd],
    });
    await context.move.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId,
      deliveryIds: [viaMove],
    });

    expect(inTransitIds()).toEqual([viaAdd, viaMove]);
    expect(context.published.map((event) => event.topic)).toEqual([
      "delivery.dispatched",
      "delivery.dispatched",
    ]);
  });

  it("says nothing of the kind onto a route that has not left", async () => {
    const target = await plannedRoute([]);
    const moving = await seedDelivery();

    await plannedRoute([moving]);

    await context.move.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: target.id,
      deliveryIds: [moving],
    });

    expect(statusOf(moving)).toBe("PENDING");
    expect(inTransitIds()).toEqual([]);
    expect(context.published).toEqual([]);
  });
});

describe("the vehicle lists hear the truck leave", () => {
  it("once, on the departure, and not on the release", async () => {
    const route = await plannedRoute([await seedDelivery()], VEHICLE);

    await context.release.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    expect(heard.catalog).toEqual([]);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      routeId: route.id,
    });

    expect(heard.catalog).toEqual([{ businessId: BUSINESS, entity: "vehicle" }]);
  });

  it.each([
    ["IN_PROGRESS", null, true],
    ["COMPLETED", new Date(), true],
    ["CANCELLED", new Date(), true],
    ["CANCELLED", null, false],
    ["RELEASED", null, false],
    ["PLANNED", null, false],
  ] as const)(
    "a route %s (left: %s) moves its truck: %s",
    (status, startedAt, moves) => {
      const route = { vehicleId: VEHICLE, status, started_at: startedAt };

      expect(routeMovesVehicle(route)).toBe(moves);
    },
  );

  it("no truck, nothing to move", () => {
    const route = { vehicleId: null, status: "IN_PROGRESS" } as const;

    expect(routeMovesVehicle(route)).toBe(false);
  });
});
