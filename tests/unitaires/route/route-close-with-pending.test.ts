import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan of 02/11/2026, K11 (decision D26): a route forgotten "Em andamento"
 * held the driver (ROUTE_DRIVER_BUSY) and the truck for days, because a
 * route only closed when its last stop resolved.
 *
 * - "Encerrar com pendências": the dispatcher closes the running route with
 *   a reason. Its open stops are cancelled, their deliveries go back to
 *   Pendente with a line saying why, the route ends COMPLETED with the
 *   reason, and the driver hears the plan changed.
 * - The hourly sweep warns the company's admins once per route left open.
 *
 * The real use cases over the in-memory twins, the transaction a
 * passthrough as in every route unit suite. The row locks and the claim
 * between two replicas are in tests/E2E/route-close-with-pending-http.test.ts.
 */
const emitted: Array<{ room: string; id: string | null; event: any }> = [];

vi.mock("@/websocket", () => ({
  sendRouteEventToBusiness: (id: string, event: unknown) => {
    emitted.push({ room: "business", id, event });
  },
  sendRouteEventToDriver: (id: string | null, event: unknown) => {
    emitted.push({ room: "driver", id, event });
  },
  // The vehicle lists' hint: the truck came back with the route.
  sendCatalogChangedEvent: (id: string, entity: string) => {
    emitted.push({ room: "catalog", id, event: { entity } });
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { CloseRouteWithPendingUseCase } from "@/modules/route/usecases/close-route-with-pending/close-route-with-pending-usecase";
import { AlertRoutesLeftOpenUseCase } from "@/modules/route/usecases/alert-routes-left-open/alert-routes-left-open-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";

const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000aa";
const DISPATCHER_B = "018f0000-0000-7000-8000-0000000000ba";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";

/** 02/11 at 09:00 in São Paulo. */
const NOW = new Date("2026-11-02T12:00:00.000Z");

let routes: InMemoryRouteRepository;
let users: InMemoryUserRepository;
let webhooks: InMemoryWebhookFanOutService;
let published: Array<{ topic: string; eventKey?: string; payload: any }>;
let activities: Array<{ description: string }>;

const outbox = {
  publish: async (_tx: unknown, input: any) => {
    published.push(input);
  },
} as unknown as OutboxService;

const notificationService = {
  createActivityIfEnabled: (activity: { description: string }) => {
    activities.push(activity);
  },
} as unknown as NotificationService;

const close = () =>
  new CloseRouteWithPendingUseCase(
    routes,
    users,
    notificationService,
    outbox,
    webhooks.asService(),
  );

async function runningRoute(
  businessId = A,
  startedAt = new Date("2026-10-30T17:57:00.000Z"),
): Promise<string> {
  const created = await routes.createRoute({
    businessId,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    scheduled_date: new Date("2026-10-30T00:00:00.000Z"),
    deliveryIds: ["d-open", "d-arrived", "d-done"].map(
      (id) => `${businessId}-${id}`,
    ),
  });

  const row = routes.routes.find((route) => route.id === created.id)!;
  row.status = "IN_PROGRESS";
  row.started_at = startedAt;

  const stops = routes.stops.filter((stop) => stop.routeId === created.id);
  stops[1].status = "ARRIVED";
  stops[2].status = "COMPLETED";

  for (const delivery of routes.deliveries) {
    if (delivery.businessId !== businessId) continue;

    delivery.status = delivery.id!.endsWith("d-done")
      ? "DELIVERED"
      : "IN_TRANSIT";
    delivery.driverId = DRIVER;
    delivery.vehicleId = VEHICLE;
  }

  return created.id;
}

beforeEach(() => {
  emitted.length = 0;
  published = [];
  activities = [];

  webhooks = new InMemoryWebhookFanOutService();
  users = new InMemoryUserRepository();

  users.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: DISPATCHER_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    } as User,
  );

  routes = new InMemoryRouteRepository(
    [A, B].flatMap((businessId) =>
      ["d-open", "d-arrived", "d-done"].map((id) => ({
        id: `${businessId}-${id}`,
        businessId,
        status: "PENDING",
        recipient_name: `Cliente ${id}`,
      })),
    ),
    [
      {
        id: VEHICLE,
        businessId: A,
        license_plate: "ABC1D23",
        status: "ACTIVE",
      },
    ],
    [{ id: DRIVER, businessId: A, name: "João", status: "ACTIVE" }],
  );
});

describe("closing a route with pending stops (K11)", () => {
  it("cancels the open stops, hands their deliveries back with a line, and completes the route with the reason", async () => {
    const routeId = await runningRoute();

    const result = await close().execute({
      userId: DISPATCHER,
      businessId: A,
      routeId,
      reason: "Motorista esqueceu a rota aberta",
      now: NOW,
    });

    expect(result).toMatchObject({
      unchanged: false,
      cancelledStops: 2,
      route: {
        status: "COMPLETED",
        closure_reason: "Motorista esqueceu a rota aberta",
        completed_at: NOW,
        plan_version: 1,
      },
    });

    const stops = routes.stops.filter((stop) => stop.routeId === routeId);

    expect(stops.map((stop) => stop.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
      "COMPLETED",
    ]);

    const byId = Object.fromEntries(
      routes.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    expect(byId[`${A}-d-open`]).toMatchObject({
      status: "PENDING",
      driverId: null,
    });
    expect(byId[`${A}-d-arrived`]).toMatchObject({ status: "PENDING" });
    // A delivery already proven keeps its outcome and its driver.
    expect(byId[`${A}-d-done`]).toMatchObject({
      status: "DELIVERED",
      driverId: DRIVER,
    });

    expect(
      routes.events
        .filter((event) => event.type === "ROUTE_REMOVED")
        .map((event) => [event.deliveryId, event.note]),
    ).toEqual([
      [
        `${A}-d-open`,
        "Rota 1 encerrada com pendências: Motorista esqueceu a rota aberta",
      ],
      [
        `${A}-d-arrived`,
        "Rota 1 encerrada com pendências: Motorista esqueceu a rota aberta",
      ],
    ]);

    // The truck is back in the yard.
    expect(routes.vehicles[0].status).toBe("ACTIVE");
  });

  it("tells the driver the plan changed, the ERP the route ended, and the boards", async () => {
    const routeId = await runningRoute();

    await close().execute({
      userId: DISPATCHER,
      businessId: A,
      routeId,
      reason: "Rota esquecida",
      now: NOW,
    });

    expect(published).toEqual([
      expect.objectContaining({
        topic: "route.plan_changed",
        eventKey: `route:${routeId}:plan:1`,
        payload: expect.objectContaining({
          driverUserId: DRIVER_USER,
          planVersion: 1,
        }),
      }),
    ]);

    expect(webhooks.announced.map((entry) => entry.topic)).toEqual([
      "route.completed",
    ]);

    expect(emitted).toEqual(
      expect.arrayContaining([
        {
          room: "business",
          id: A,
          event: expect.objectContaining({ type: "route.completed", routeId }),
        },
        {
          room: "driver",
          id: DRIVER_USER,
          event: expect.objectContaining({
            type: "route.stops_changed",
            routeId,
            planVersion: 1,
          }),
        },
        // Its truck is free again (audit of 25/11/2026).
        { room: "catalog", id: A, event: { entity: "vehicle" } },
      ]),
    );

    expect(activities[0].description).toBe(
      "Rota 1 encerrada com pendências (2 paradas canceladas): Rota esquecida",
    );
  });

  it("answers a resend as unchanged, without writing or telling anyone again", async () => {
    const routeId = await runningRoute();
    const request = {
      userId: DISPATCHER,
      businessId: A,
      routeId,
      reason: "Rota esquecida",
      now: NOW,
    };

    await close().execute(request);

    published = [];
    emitted.length = 0;

    const again = await close().execute(request);

    expect(again).toMatchObject({ unchanged: true, cancelledStops: 0 });
    expect(published).toEqual([]);
    expect(emitted).toEqual([]);
    expect(webhooks.announced).toHaveLength(1);
  });

  it("refuses a route that is not running with 409, and another company's with 404", async () => {
    const routeId = await runningRoute();

    routes.routes.find((route) => route.id === routeId)!.status = "RELEASED";

    await expect(
      close().execute({
        userId: DISPATCHER,
        businessId: A,
        routeId,
        reason: "Rota esquecida",
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_STATUS_CONFLICT" });

    await expect(
      close().execute({
        userId: DISPATCHER_B,
        businessId: B,
        routeId,
        reason: "Rota esquecida",
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a driver token and a blank reason", async () => {
    const routeId = await runningRoute();

    await expect(
      close().execute({
        userId: DRIVER_USER,
        businessId: A,
        routeId,
        reason: "Rota esquecida",
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      close().execute({
        userId: DISPATCHER,
        businessId: A,
        routeId,
        reason: "   ",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ROUTE_CLOSURE_REASON_REQUIRED",
    });
  });
});

describe("the hourly sweep of routes left open (K11)", () => {
  const sweep = () => new AlertRoutesLeftOpenUseCase(routes, outbox);

  it("warns the admins once per route left open, and never about today's", async () => {
    routes.timeZones[A] = "America/Sao_Paulo";

    const forgotten = await runningRoute(
      A,
      new Date("2026-10-30T17:57:00.000Z"),
    );
    const fresh = await runningRoute(B, new Date("2026-11-02T10:00:00.000Z"));

    const first = await sweep().execute({ now: NOW });

    expect(first).toEqual([forgotten]);
    expect(published).toEqual([
      {
        topic: "route.left_open",
        aggregateType: "route",
        aggregateId: forgotten,
        businessId: A,
        eventKey: `route.left_open:${forgotten}`,
        payload: {
          routeId: forgotten,
          businessId: A,
          code: 1,
          routeName: null,
          driverName: "João",
          startedAt: "2026-10-30T17:57:00.000Z",
          sinceLabel: "30/10 às 14:57",
          openDays: 3,
        },
      },
    ]);

    // An hour later: nothing new to say about the same route.
    published = [];

    expect(
      await sweep().execute({ now: new Date(NOW.getTime() + 3_600_000) }),
    ).toEqual([]);
    expect(published).toEqual([]);

    // Today's route becomes "left open" once the company's day turns.
    expect(
      await sweep().execute({ now: new Date("2026-11-03T03:30:00.000Z") }),
    ).toEqual([fresh]);
  });
});
