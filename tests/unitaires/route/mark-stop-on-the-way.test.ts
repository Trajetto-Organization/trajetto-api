import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/errors/AppError";

/**
 * "Estou a caminho" (decision 6.4), the use case over the in-memory twins.
 *
 * The twins share the other fakes' arrays (routes, stops, deliveries,
 * events), as the tables are one database in Postgres. What needs the real
 * database — the lock order, the unique index racing, the guards on the
 * URL, the pipeline sending the message — is in
 * tests/E2E/route-stop-on-the-way.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const emitted: Array<{ businessId: string; event: Record<string, unknown> }> =
  [];

vi.mock("@/websocket", () => ({
  sendRouteEventToBusiness: (
    businessId: string,
    event: Record<string, unknown>,
  ) => {
    emitted.push({ businessId, event });
  },
}));

import { MarkStopOnTheWayUseCase } from "@/modules/route/usecases/mark-stop-on-the-way/mark-stop-on-the-way-usecase";
import { InMemoryStopOnTheWayRepository } from "@/modules/route/usecases/mark-stop-on-the-way/in-memory-stop-on-the-way-repository";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";
import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";
import type { User } from "@/modules/user/dtos/user-dto";

const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DRIVER_A = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER_A = "018f0000-0000-7000-8000-0000000000d2";
const DRIVER_B = "018f0000-0000-7000-8000-0000000000d3";

const DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a1";
const OTHER_DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a2";
const DISPATCHER_A = "018f0000-0000-7000-8000-0000000000a3";
const DRIVER_USER_B = "018f0000-0000-7000-8000-0000000000b1";

const ROUTE = "018f0000-0000-7000-8000-0000000000c1";
const STOP_1 = "018f0000-0000-7000-8000-0000000000e1";
const STOP_2 = "018f0000-0000-7000-8000-0000000000e2";
const DELIVERY_1 = "018f0000-0000-7000-8000-0000000000f1";
const DELIVERY_2 = "018f0000-0000-7000-8000-0000000000f2";

const SUBMISSION = "018f0000-0000-7000-8000-000000000101";
const SUBMISSION_2 = "018f0000-0000-7000-8000-000000000102";

const STARTED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000);

let routes: InMemoryRouteRepository;
let deliveries: InMemoryDeliveryRepository;
let users: InMemoryUserRepository;
let stops: InMemoryStopOnTheWayRepository;
let published: Array<{
  topic: string;
  eventKey?: string;
  payload: Record<string, unknown>;
}>;
let useCase: MarkStopOnTheWayUseCase;

function route(overrides: Partial<Route> = {}): Route {
  return {
    id: ROUTE,
    code: 7,
    name: null,
    status: "IN_PROGRESS",
    scheduled_date: new Date("2026-09-29T00:00:00.000Z"),
    destination: null,
    planned_departure_at: null,
    planned_arrival_at: null,
    started_at: STARTED_AT,
    completed_at: null,
    cancellation_reason: null,
    businessId: A,
    driverId: DRIVER_A,
    vehicleId: null,
    importId: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Route;
}

function stop(id: string, deliveryId: string, sequence: number): RouteStop {
  return {
    id,
    sequence,
    status: "PENDING",
    arrived_at: null,
    completed_at: null,
    routeId: ROUTE,
    deliveryId,
    created_at: new Date(),
    updated_at: new Date(),
    ...{ on_the_way_at: null },
  } as RouteStop;
}

function delivery(
  id: string,
  contact: { telephone?: string | null },
): Delivery {
  return {
    id,
    recipient_name: `Destinatário ${id.slice(-2)}`,
    recipient_telephone: contact.telephone ?? null,
    recipient_email: null,
    city: "Cuiabá",
    uf: "MT",
    street: "Rua",
    status: "IN_TRANSIT",
    businessId: A,
    shipperId: "shipper",
    driverId: DRIVER_A,
  };
}

const onTheWayOf = (stopId: string) =>
  (
    routes.stops.find((entry) => entry.id === stopId) as RouteStop & {
      on_the_way_at?: Date | null;
    }
  ).on_the_way_at ?? null;

const eventsOfType = (type: string) =>
  deliveries.events.filter((event) => event.type === type);

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(AppError);

  return error as AppError;
}

beforeEach(() => {
  emitted.length = 0;
  published = [];

  deliveries = new InMemoryDeliveryRepository();
  routes = new InMemoryRouteRepository(deliveries.deliveries);

  deliveries.deliveries.push(
    delivery(DELIVERY_1, { telephone: "65999990000" }),
    delivery(DELIVERY_2, { telephone: null }),
  );

  routes.routes.push(route());
  routes.stops.push(stop(STOP_1, DELIVERY_1, 10), stop(STOP_2, DELIVERY_2, 20));

  users = new InMemoryUserRepository();

  users.user.push(
    {
      id: DRIVER_USER_A,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_A,
    } as User,
    {
      id: OTHER_DRIVER_USER_A,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: OTHER_DRIVER_A,
    } as User,
    {
      id: DISPATCHER_A,
      role: "BUSINESS_ADMIN",
      businessId: A,
      driverId: null,
    } as User,
    {
      id: DRIVER_USER_B,
      role: "BUSINESS_USER",
      businessId: B,
      driverId: DRIVER_B,
    } as User,
  );

  stops = new InMemoryStopOnTheWayRepository(
    routes.routes,
    routes.stops,
    deliveries.deliveries,
    deliveries.events,
  );

  const outbox = {
    publish: async (
      _tx: unknown,
      event: {
        topic: string;
        eventKey?: string;
        payload: Record<string, unknown>;
      },
    ) => {
      published.push(event);
    },
  } as unknown as OutboxService;

  const notificationService = {
    createActivityIfEnabled: () => undefined,
  } as unknown as NotificationService;

  useCase = new MarkStopOnTheWayUseCase(
    users,
    stops,
    outbox,
    notificationService,
  );
});

const mark = (
  overrides: Partial<Parameters<MarkStopOnTheWayUseCase["execute"]>[0]> = {},
) =>
  useCase.execute({
    userId: DRIVER_USER_A,
    businessId: A,
    routeId: ROUTE,
    stopId: STOP_1,
    client_submission_id: SUBMISSION,
    ...overrides,
  });

describe("the driver marks a pending stop of their running route", () => {
  it("stamps the stop, records the event and tells the operation", async () => {
    const result = await mark({ latitude: -15.6, longitude: -56.1 });

    expect(result).toMatchObject({
      stopId: STOP_1,
      routeId: ROUTE,
      deliveryId: DELIVERY_1,
    });
    expect(onTheWayOf(STOP_1)).toEqual(result.on_the_way_at);

    const [event] = eventsOfType("ON_THE_WAY");

    expect(event).toMatchObject({
      deliveryId: DELIVERY_1,
      routeId: ROUTE,
      businessId: A,
      actor: "DRIVER_APP",
      reportedById: DRIVER_USER_A,
      client_submission_id: SUBMISSION,
      latitude: -15.6,
      longitude: -56.1,
      occurred_at: result.on_the_way_at,
    });

    // The stop's status does not move: "a caminho" is not an outcome.
    expect(routes.stops.find((entry) => entry.id === STOP_1)?.status).toBe(
      "PENDING",
    );

    expect(emitted).toEqual([
      {
        businessId: A,
        event: {
          type: "route-stop.on_the_way",
          routeId: ROUTE,
          routeCode: 7,
          stopId: STOP_1,
          stopStatus: "PENDING",
          deliveryId: DELIVERY_1,
          onTheWayAt: result.on_the_way_at.toISOString(),
        },
      },
    ]);
  });

  it("dates a mark queued offline by the tap, never before the departure", async () => {
    const tap = new Date(STARTED_AT.getTime() + 60_000);

    expect((await mark({ occurredAt: tap })).on_the_way_at).toEqual(tap);

    const beforeDeparture = new Date(STARTED_AT.getTime() - 5_000);

    const second = await mark({
      stopId: STOP_2,
      client_submission_id: SUBMISSION_2,
      occurredAt: beforeDeparture,
    });

    expect(second.on_the_way_at).toEqual(STARTED_AT);
  });

  it("keeps the previous stop's instant when the driver turns to another one", async () => {
    const first = await mark({
      occurredAt: new Date(STARTED_AT.getTime() + 60_000),
    });
    await mark({
      stopId: STOP_2,
      client_submission_id: SUBMISSION_2,
      occurredAt: new Date(STARTED_AT.getTime() + 120_000),
    });

    expect(onTheWayOf(STOP_1)).toEqual(first.on_the_way_at);
    expect(onTheWayOf(STOP_2)!.getTime()).toBeGreaterThan(
      first.on_the_way_at.getTime(),
    );
    expect(eventsOfType("ON_THE_WAY")).toHaveLength(2);
  });

  it("never moves a stop back in time on an out-of-order older tap", async () => {
    const late = new Date(STARTED_AT.getTime() + 120_000);
    const early = new Date(STARTED_AT.getTime() + 60_000);

    await mark({ occurredAt: late });
    const older = await mark({
      client_submission_id: SUBMISSION_2,
      occurredAt: early,
    });

    // The event records its own tap; the stop keeps the latest.
    expect(older.on_the_way_at).toEqual(early);
    expect(onTheWayOf(STOP_1)).toEqual(late);
  });
});

describe("a resend of the same submission", () => {
  it("answers the same result without a second event", async () => {
    const first = await mark();
    const again = await mark();

    expect(again).toEqual(first);
    expect(eventsOfType("ON_THE_WAY")).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("answers the same result after the stop moved on", async () => {
    const first = await mark();

    routes.stops.find((entry) => entry.id === STOP_1)!.status = "COMPLETED";
    routes.routes[0].status = "COMPLETED";

    expect(await mark()).toEqual(first);
  });

  it("refuses the same key on another stop with SUBMISSION_ID_REUSED", async () => {
    await mark();

    const error = await refusal(mark({ stopId: STOP_2 }));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("SUBMISSION_ID_REUSED");
    expect(onTheWayOf(STOP_2)).toBeNull();
  });

  it("refuses a key another kind of event already used", async () => {
    deliveries.events.push({
      id: "event-arrival",
      type: "ARRIVAL",
      deliveryId: DELIVERY_1,
      client_submission_id: SUBMISSION,
      created_at: new Date(),
    });

    const error = await refusal(mark());

    expect(error.code).toBe("SUBMISSION_ID_REUSED");
    expect(eventsOfType("ON_THE_WAY")).toHaveLength(0);
  });
});

describe("who may mark", () => {
  it("refuses a user who is not a driver with PERMISSION_DENIED (decision 4.1)", async () => {
    const error = await refusal(mark({ userId: DISPATCHER_A }));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(eventsOfType("ON_THE_WAY")).toHaveLength(0);
  });

  it("answers another driver's route like a missing stop", async () => {
    const error = await refusal(mark({ userId: OTHER_DRIVER_USER_A }));

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("ROUTE_STOP_NOT_FOUND");
    expect(onTheWayOf(STOP_1)).toBeNull();
  });

  it("answers another company's stop like a missing one", async () => {
    // B's driver naming A's route and stop under B's company.
    const error = await refusal(mark({ userId: DRIVER_USER_B, businessId: B }));

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("ROUTE_STOP_NOT_FOUND");
  });

  it("answers a stop of another route like a missing one", async () => {
    const error = await refusal(
      mark({ routeId: "018f0000-0000-7000-8000-0000000000c9" }),
    );

    expect(error.code).toBe("ROUTE_STOP_NOT_FOUND");
  });

  it("answers a caller deleted since the token with USER_NOT_FOUND", async () => {
    const error = await refusal(
      mark({ userId: "018f0000-0000-7000-8000-0000000000ff" }),
    );

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("USER_NOT_FOUND");
  });
});

describe("what state refuses", () => {
  it.each(["ARRIVED", "COMPLETED", "FAILED", "CANCELLED"] as const)(
    "a stop %s: 409 ROUTE_STOP_NOT_PENDING, nothing written",
    async (status) => {
      routes.stops.find((entry) => entry.id === STOP_1)!.status = status;

      const error = await refusal(mark());

      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("ROUTE_STOP_NOT_PENDING");
      expect(onTheWayOf(STOP_1)).toBeNull();
      expect(eventsOfType("ON_THE_WAY")).toHaveLength(0);
      expect(emitted).toHaveLength(0);
      expect(published).toHaveLength(0);
    },
  );

  it.each(["PLANNED", "RELEASED", "COMPLETED", "CANCELLED"] as const)(
    "a route %s: 409 ROUTE_NOT_IN_PROGRESS, nothing written",
    async (status) => {
      routes.routes[0].status = status;

      const error = await refusal(mark());

      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("ROUTE_NOT_IN_PROGRESS");
      expect(eventsOfType("ON_THE_WAY")).toHaveLength(0);
    },
  );
});

describe("the customer notice", () => {
  it("is published once per stop, keyed by the stop, with the delivery's contact", async () => {
    await mark();
    await mark({ client_submission_id: SUBMISSION_2 });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      topic: "delivery.on_the_way",
      eventKey: `delivery.on_the_way:${STOP_1}`,
      payload: {
        deliveryId: DELIVERY_1,
        businessId: A,
        recipientTelephone: "65999990000",
      },
    });
  });

  it("is not published for a delivery with nobody to tell", async () => {
    await mark({ stopId: STOP_2 });

    expect(published).toHaveLength(0);
    expect(eventsOfType("ON_THE_WAY")).toHaveLength(1);
  });

  it("is not published for a tap that reached the API over an hour late", async () => {
    routes.routes[0].started_at = new Date(Date.now() - 5 * 60 * 60 * 1000);

    await mark({ occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    expect(published).toHaveLength(0);
    expect(onTheWayOf(STOP_1)).not.toBeNull();
  });
});
