import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Adicionar à rota" into a route that ended (owner's report of 25/11/2026).
 *
 * A route cancelled on another screen stayed in the Entregas dialog's list,
 * and choosing it answered "Essas entregas já estão nesta rota." — the
 * dispatcher could not tell the route was gone. add-stops and move-stops
 * now answer an ended target first, naming the route and its state, before
 * the idempotent "already on this route" shortcut and before any source is
 * touched. And a new route tells the operations room (`route.created`), so a
 * colleague's open picker learns it exists without a reload.
 *
 * The real use cases over the in-memory repositories, with the transaction a
 * passthrough as in every route unit suite.
 */
const emitted = vi.hoisted(
  () => [] as Array<{ businessId: string; event: Record<string, unknown> }>,
);

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: (
    businessId: string,
    event: Record<string, unknown>,
  ) => {
    emitted.push({ businessId, event });
  },
  sendRouteEventToDriver: () => undefined,
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { MoveRouteStopsUseCase } from "@/modules/route/usecases/move-route-stops/move-route-stops-usecase";
import {
  ROUTE_APPENDABLE_STATUSES,
  routeNotAppendable,
} from "@/modules/route/usecases/shared/route-plan-rules";
import { RouteStatusConflictError } from "@/modules/route/usecases/errors/route-errors";

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
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { RouteStatus } from "@/shared/route/route-rules";

const BUSINESS = "018f0000-0000-7000-8000-000000000b0b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-000000000b0c";
const DISPATCHER = "018f0000-0000-7000-8000-000000000baa";
const OTHER_DISPATCHER = "018f0000-0000-7000-8000-000000000bab";
const DRIVER = "018f0000-0000-7000-8000-000000000bd1";
const VEHICLE = "018f0000-0000-7000-8000-000000000be1";
const SHIPPER = "018f0000-0000-7000-8000-000000000bf1";
const DAY = new Date("2026-11-25T00:00:00.000Z");

function makeContext() {
  const notifications = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  const outbox = {
    publish: async () => undefined,
    publishAfterCommit: async () => undefined,
  } as unknown as OutboxService;

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
      id: OTHER_DISPATCHER,
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
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
    deliveries,
    routes,
    cancel,
    create: new CreateRouteUseCase(
      routes,
      users,
      deliveries,
      drivers,
      vehicles,
      notifications,
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
    move: new MoveRouteStopsUseCase(
      routes,
      users,
      deliveries,
      cancel,
      notifications,
      webhooks,
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  emitted.length = 0;
  context = makeContext();
});

async function seedDelivery(): Promise<string> {
  const created = await context.deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatária",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function plannedRoute(
  deliveryIds: string[],
): Promise<{ id: string; code: number }> {
  const route = await context.create.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    scheduled_date: DAY,
    deliveryIds,
  });

  return { id: route.id, code: route.code };
}

const routeRow = (routeId: string) =>
  context.routes.routes.find((route) => route.id === routeId)!;

const openStopRouteOf = (deliveryId: string) =>
  context.routes.stops.find(
    (stop) =>
      stop.deliveryId === deliveryId &&
      (stop.status === "PENDING" || stop.status === "ARRIVED"),
  )?.routeId ?? null;

/** The refusal as "status code: message", or a failure if none came. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return `${error.statusCode} ${error.code}: ${error.message}`;
    }

    throw error;
  }

  throw new Error("expected a refusal");
}

describe("which routes take new stops", () => {
  it("is planned, released and running — nothing that ended", () => {
    expect([...ROUTE_APPENDABLE_STATUSES]).toEqual([
      "PLANNED",
      "RELEASED",
      "IN_PROGRESS",
    ]);

    for (const status of ROUTE_APPENDABLE_STATUSES) {
      expect(routeNotAppendable({ code: 8, status })).toBeNull();
    }
  });

  it.each<[RouteStatus, string]>([
    [
      "CANCELLED",
      "A Rota 8 foi cancelada e não aceita novas entregas. Atualize a lista e escolha outra rota.",
    ],
    [
      "COMPLETED",
      "A Rota 8 foi concluída e não aceita novas entregas. Atualize a lista e escolha outra rota.",
    ],
  ])("names the route and says it is %s", (status, message) => {
    expect(routeNotAppendable({ code: 8, status })).toMatchObject({
      statusCode: 409,
      code: "ROUTE_STATUS_CONFLICT",
      message,
    });
  });
});

describe("add-stops into a route that ended", () => {
  it("refuses a cancelled route by name, never as 'already on this route'", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      reason: "Cliente remarcou",
    });

    const late = await seedDelivery();

    expect(
      await refusal(
        context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: route.id,
          deliveryIds: [late],
        }),
      ),
    ).toBe(
      `409 ROUTE_STATUS_CONFLICT: A Rota ${route.code} foi cancelada e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    );

    expect(openStopRouteOf(late)).toBeNull();
  });

  it("refuses an ended route even when the delivery still reads as one of its stops", async () => {
    // Red before: the "already on this route" shortcut ran first and
    // answered 201 with the delivery in `alreadyOnRoute` — the screen
    // said it was there, on a route nobody will run.
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    routeRow(route.id).status = "COMPLETED";

    expect(
      await refusal(
        context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: route.id,
          deliveryIds: [delivery],
        }),
      ),
    ).toBe(
      `409 ROUTE_STATUS_CONFLICT: A Rota ${route.code} foi concluída e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    );
  });

  it("names the state the route reached when it ended between the check and the lock", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    // The cancellation commits on another screen while this one waits for
    // the route's lock: the lock finds it no longer appendable.
    vi.spyOn(context.routes, "addStops").mockImplementationOnce(async () => {
      routeRow(route.id).status = "CANCELLED";
      throw new RouteStatusConflictError();
    });

    expect(
      await refusal(
        context.addStops.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: route.id,
          deliveryIds: [await seedDelivery()],
        }),
      ),
    ).toBe(
      `409 ROUTE_STATUS_CONFLICT: A Rota ${route.code} foi cancelada e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    );
  });

  it("answers another company's route as absent, without its number or state", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    routeRow(route.id).status = "CANCELLED";

    expect(
      await refusal(
        context.addStops.execute({
          userId: OTHER_DISPATCHER,
          businessId: OTHER_BUSINESS,
          routeId: route.id,
          deliveryIds: [await seedDelivery()],
        }),
      ),
    ).toMatch(/^404 DELIVERY_ROUTE_NOT_FOUND: /);
  });
});

describe("move-stops into a route that ended", () => {
  it("refuses a cancelled target by name and leaves the source as it was", async () => {
    const delivery = await seedDelivery();
    const source = await plannedRoute([delivery]);
    const target = await plannedRoute([await seedDelivery()]);

    await context.cancel.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: target.id,
      reason: "Veículo quebrou",
    });

    const versionBefore = routeRow(source.id).plan_version;

    expect(
      await refusal(
        context.move.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: target.id,
          deliveryIds: [delivery],
        }),
      ),
    ).toBe(
      `409 ROUTE_STATUS_CONFLICT: A Rota ${target.code} foi cancelada e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    );

    expect(openStopRouteOf(delivery)).toBe(source.id);
    expect(routeRow(source.id).plan_version).toBe(versionBefore);
  });

  it("refuses an ended target even when the deliveries still read as its stops", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    routeRow(route.id).status = "COMPLETED";

    expect(
      await refusal(
        context.move.execute({
          userId: DISPATCHER,
          businessId: BUSINESS,
          routeId: route.id,
          deliveryIds: [delivery],
        }),
      ),
    ).toBe(
      `409 ROUTE_STATUS_CONFLICT: A Rota ${route.code} foi concluída e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    );
  });

  it("still answers a delivery already on an open target as a retry", async () => {
    const delivery = await seedDelivery();
    const route = await plannedRoute([delivery]);

    const result = await context.move.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      routeId: route.id,
      deliveryIds: [delivery],
    });

    expect(result).toMatchObject({
      stops: [],
      moved: [],
      alreadyOnRoute: [delivery],
    });
  });
});

describe("a new route tells the operations room", () => {
  it("emits route.created to its company, with its id and number", async () => {
    const route = await plannedRoute([await seedDelivery()]);

    expect(emitted).toEqual([
      {
        businessId: BUSINESS,
        event: {
          type: "route.created",
          routeId: route.id,
          routeCode: route.code,
        },
      },
    ]);
  });

  it("emits nothing for a creation that was refused", async () => {
    await expect(
      context.create.execute({
        userId: OTHER_DISPATCHER,
        businessId: BUSINESS,
        driverId: DRIVER,
        vehicleId: VEHICLE,
        scheduled_date: DAY,
        deliveryIds: [],
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(emitted).toEqual([]);
  });
});
