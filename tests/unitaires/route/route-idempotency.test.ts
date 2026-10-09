import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import { StartDriverRouteUseCase } from "@/modules/delivery/usecases/start-driver-route/start-driver-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * What a route says it did, against what it actually did — resends, stale
 * reads and overrides that used to leave the two disagreeing.
 *
 * Same wiring as route-stop-lifecycle: the real use cases over the in-memory
 * repositories, sharing ONE delivery store, because in Postgres the route and
 * its deliveries are one database and a test with two stores can prove a
 * departure that moved nothing.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const A = "018f0000-0000-7000-8000-00000000000a";
const REASON = "018f0000-0000-7000-8000-0000000000e9";

const DISPATCHER_A = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_A = "018f0000-0000-7000-8000-0000000000d1";

const VEHICLE_A = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const TODAY = new Date("2026-09-15T08:00:00.000Z");

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function makeContext() {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];

  const outbox = {
    publish: async (
      _tx: unknown,
      event: { topic: string; payload: Record<string, unknown> },
    ) => {
      published.push({ topic: event.topic, payload: event.payload });
    },
  } as unknown as OutboxService;

  const webhooks = new InMemoryWebhookFanOutService();

  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  const reasonRepository = new InMemoryStatusChangeReasonRepository();

  reasonRepository.statusChangeReasons.push({
    id: REASON,
    name: "Contato com o cliente",
    description: null,
    is_active: true,
    businessId: A,
  });

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  userRepository.user.push(
    { id: DISPATCHER_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    {
      id: DRIVER_USER_A,
      name: "João",
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

  routeRepository.vehicles = vehicleRepository.vehicles;

  vehicleRepository.vehicles.push({
    id: VEHICLE_A,
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: A,
    driverId: DRIVER_A,
  } as Vehicle);

  const start = new StartRouteUseCase(
    routeRepository,
    userRepository,
    vehicleRepository,
    notificationService,
    outbox,
    webhooks.asService(),
  );

  return {
    published,
    webhooks,
    routeRepository,
    deliveryRepository,
    vehicleRepository,
    userRepository,

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
      outbox,
      webhooks.asService(),
    ),
    start,
    cancel: new CancelRouteUseCase(
      routeRepository,
      userRepository,
      notificationService,
      outbox,
      webhooks.asService(),
    ),
    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      reasonRepository,
      notificationService,
      outbox,
      webhooks.asService(),
    ),

    // The endpoint the app uses only when it knows no route.
    legacyStart: new StartDriverRouteUseCase(
      userRepository,
      deliveryRepository,
      vehicleRepository,
      notificationService,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(recipient = "Destinatário"): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    recipient_name: recipient,
    recipient_email: `${recipient.toLowerCase().replace(/\s/g, ".")}@exemplo.com.br`,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function releasedRoute(deliveryIds: string[]): Promise<string> {
  const route = await context.create.execute({
    userId: DISPATCHER_A,
    businessId: A,
    driverId: DRIVER_A,
    vehicleId: VEHICLE_A,
    scheduled_date: TODAY,
    deliveryIds,
  });

  await context.release.execute({
    userId: DISPATCHER_A,
    businessId: A,
    routeId: route.id,
  });

  return route.id;
}

async function runningRoute(deliveryIds: string[]): Promise<string> {
  const routeId = await releasedRoute(deliveryIds);

  await context.start.execute({
    userId: DRIVER_USER_A,
    businessId: A,
    routeId,
  });

  return routeId;
}

const deliveryFor = (id: string) =>
  context.deliveryRepository.deliveries.find((entry) => entry.id === id)!;

const routeFor = (id: string) =>
  context.routeRepository.routes.find((route) => route.id === id)!;

const stopsFor = (deliveryId: string) =>
  context.routeRepository.stops.filter((stop) => stop.deliveryId === deliveryId);

const dispatchedTo = () =>
  context.published
    .filter((event) => event.topic === "delivery.dispatched")
    .map((event) => event.payload.deliveryId);

describe("a route with nothing left on it (IDEMP-05)", () => {
  it("refuses to depart instead of running forever", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    // Its only stop removed after the release.
    await context.routeRepository.removeStops(routeId, A, [
      stopsFor(delivery)[0].id,
    ]);

    // Before: IN_PROGRESS with no stop — it can never close (a route only
    // closes when a stop resolves), and the truck stays "Em rota".
    await expect(
      context.start.execute({ userId: DRIVER_USER_A, businessId: A, routeId }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_WITHOUT_STOPS" });

    expect(routeFor(routeId).status).toBe("RELEASED");
  });
});

describe("a delivery that goes back to the pool (IDEMP-11)", () => {
  const setStatus = (deliveryId: string, status: "PENDING" | "DELIVERED" | "CANCELLED") =>
    context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId,
      status,
      reasonId: REASON,
    });

  it("returning an in-transit delivery to pending takes it off the running route", async () => {
    const postponed = await seedDelivery("Adiada");
    const delivered = await seedDelivery("Entregue");

    const routeId = await runningRoute([postponed, delivered]);

    // The customer asked to postpone; the dispatcher sends it back to pending.
    await setStatus(postponed, "PENDING");

    // Before: the stop stayed PENDING on the running route — the driver saw
    // an address refused at arrival and proof, the route never closed, and
    // the delivery could not join tomorrow's route (409).
    expect(stopsFor(postponed).map((stop) => stop.status)).toEqual(["CANCELLED"]);
    expect(deliveryFor(postponed).status).toBe("PENDING");
    expect(deliveryFor(postponed).driverId).toBeNull();
    expect(deliveryFor(postponed).vehicleId).toBeNull();

    // The driver loses an address and is told so.
    const notice = context.published.find(
      (event) => event.topic === "delivery.status_overridden",
    );

    expect(notice?.payload.removedFromWorklist).toBe(true);

    // The rest of the route closes on its own again.
    await setStatus(delivered, "DELIVERED");

    expect(routeFor(routeId).status).toBe("COMPLETED");
    expect(
      context.vehicleRepository.vehicles.find((entry) => entry.id === VEHICLE_A)!
        .status,
    ).toBe("ACTIVE");

    // And the postponed delivery can go on tomorrow's route.
    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        vehicleId: VEHICLE_A,
        scheduled_date: TODAY,
        deliveryIds: [postponed],
      }),
    ).resolves.toBeTruthy();
  });

  it("cancelling a delivery on a released route takes its stop off the plan", async () => {
    const cancelled = await seedDelivery("Cancelada");
    const kept = await seedDelivery("Mantida");

    const routeId = await releasedRoute([cancelled, kept]);

    await setStatus(cancelled, "CANCELLED");

    // Before: an open stop for a cancelled delivery — carried onto the street
    // at departure, never resolvable, and the route never closed.
    expect(stopsFor(cancelled)).toHaveLength(0);
    expect(deliveryFor(cancelled).driverId).toBeNull();

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId,
    });

    await setStatus(kept, "DELIVERED");

    expect(routeFor(routeId).status, "rota zumbi").toBe("COMPLETED");
  });

  it("maps the return to pending only when it comes off the street", () => {
    const at = new Date();

    expect(stopOutcomeForDelivery("PENDING", at, "IN_TRANSIT")).toMatchObject({
      status: "CANCELLED",
      releaseDelivery: true,
    });

    // A failed delivery reopened for redelivery has no open stop to settle:
    // its attempt was already recorded, and it gets a NEW stop elsewhere.
    expect(stopOutcomeForDelivery("PENDING", at, "FAILED")).toBeNull();
    expect(stopOutcomeForDelivery("PENDING", at)).toBeNull();
  });
});

describe("resending the departure (IDEMP-17)", () => {
  it("the legacy departure never starts a route the request did not name", async () => {
    // The app calls the legacy endpoint only when none of the deliveries it
    // shows is on a route. A tap queued offline and delivered after the
    // dispatcher released a route is not a request to start THAT route.
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    // Before: the route left — "saiu para entrega" to every customer and
    // route.started to every integration, with the truck still in the yard.
    expect(result).toEqual({ started: 0 });
    expect(routeFor(routeId).status).toBe("RELEASED");
    expect(deliveryFor(delivery).status).toBe("PENDING");
    expect(dispatchedTo()).toEqual([]);
  });

  it("the legacy departure moves the loose deliveries and leaves a released route alone", async () => {
    const onRoute = await seedDelivery("Na rota");
    const loose = await seedDelivery("Avulsa");

    const routeId = await releasedRoute([onRoute]);

    // Designated by hand, before routes existed.
    deliveryFor(loose).driverId = DRIVER_A;

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    // Before: the ROUTE started, and the loose delivery the driver was
    // looking at stayed behind.
    expect(result).toEqual({ started: 1 });
    expect(deliveryFor(loose).status).toBe("IN_TRANSIT");
    expect(routeFor(routeId).status).toBe("RELEASED");
    expect(deliveryFor(onRoute).status).toBe("PENDING");
  });

  it("a departure resent after the route finished answers with the route", async () => {
    const delivery = await seedDelivery();
    const routeId = await runningRoute([delivery]);

    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: delivery,
      status: "DELIVERED",
      reasonId: REASON,
    });

    expect(routeFor(routeId).status).toBe("COMPLETED");

    // The outbox resends the departure after the day is over (the first
    // answer was lost). Before: 400 INVALID_ROUTE_TRANSITION, which the app
    // shows as a permanent failure for a departure that happened.
    const resent = await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId,
    });

    expect(resent.id).toBe(routeId);
    expect(resent.status).toBe("COMPLETED");
  });

  it("still refuses to start a route that was cancelled before it left", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId,
      reason: "Replanejada",
    });

    await expect(
      context.start.execute({ userId: DRIVER_USER_A, businessId: A, routeId }),
    ).rejects.toMatchObject({ code: "INVALID_ROUTE_TRANSITION" });
  });
});

describe("the departure announces what actually left (IDEMP-06)", () => {
  it("does not announce a stop removed after the route was read", async () => {
    const kept = await seedDelivery("Cliente Um");
    const removed = await seedDelivery("Cliente Dois");

    const routeId = await releasedRoute([kept, removed]);

    const stopOfRemoved = stopsFor(removed)[0];

    // The dispatcher removes the stop in the window between the departure
    // reading the route and writing it — here, while the vehicle is checked.
    const findVehicle = context.vehicleRepository.findVehicleById.bind(
      context.vehicleRepository,
    );

    vi.spyOn(context.vehicleRepository, "findVehicleById").mockImplementationOnce(
      async (id: string) => {
        await context.routeRepository.removeStops(routeId, A, [stopOfRemoved.id]);

        return findVehicle(id);
      },
    );

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId,
    });

    // Before: "saiu para entrega" went to the customer of an address that was
    // taken off the truck — read from the snapshot taken before the write.
    expect(dispatchedTo()).toEqual([kept]);
    expect(deliveryFor(removed).status).toBe("PENDING");
  });

  it("does not announce a delivery that was cancelled while its stop waited", async () => {
    const kept = await seedDelivery("Cliente Um");
    const cancelled = await seedDelivery("Cliente Dois");

    const routeId = await releasedRoute([kept, cancelled]);

    // A stop left open for a delivery that is no longer going anywhere — the
    // state a cancellation used to leave on a released route.
    deliveryFor(cancelled).status = "CANCELLED";

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId,
    });

    expect(routeFor(routeId).status).toBe("IN_PROGRESS");
    expect(dispatchedTo()).toEqual([kept]);
  });
});
