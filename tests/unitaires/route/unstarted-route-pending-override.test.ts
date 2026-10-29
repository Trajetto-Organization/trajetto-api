import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
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

/**
 * "Back to pending" on a route that has NOT left (IDEMP-11 review).
 *
 * IN_TRANSIT → PENDING is a load coming back off the street, and on a RUNNING
 * route it cancels the stop and releases the delivery. On a route that is
 * still a plan nothing came back from anywhere: the dispatcher is undoing a
 * mistaken "Em rota" on a document that sits on tomorrow's released route.
 * PENDING on a released route is exactly the state it had before the mistake,
 * so the stop and the driver's shadow must stay where they were — not vanish
 * from the plan (and from the driver's phone) without a word to anyone.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const A = "018f0000-0000-7000-8000-00000000001a";
const REASON = "018f0000-0000-7000-8000-0000000001e9";

const DISPATCHER = "018f0000-0000-7000-8000-0000000001a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000001a2";
const DRIVER = "018f0000-0000-7000-8000-0000000001d1";

const VEHICLE = "018f0000-0000-7000-8000-0000000001e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000001f1";

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
    name: "Correção de lançamento",
    description: null,
    is_active: true,
    businessId: A,
  });

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  userRepository.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: A } as User,
    {
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    } as User,
  );

  driverRepository.drivers.push({
    id: DRIVER,
    name: "João",
    status: "ACTIVE",
    businessId: A,
  } as Driver);

  routeRepository.vehicles = vehicleRepository.vehicles;

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    license_plate: "BBB2B22",
    status: "ACTIVE",
    businessId: A,
    driverId: DRIVER,
  } as Vehicle);

  return {
    published,
    routeRepository,
    deliveryRepository,

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
    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      reasonRepository,
      notificationService,
      outbox,
      webhooks.asService(),
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(recipient: string): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    recipient_name: recipient,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

const setStatus = (deliveryId: string, status: "PENDING" | "IN_TRANSIT") =>
  context.setStatus.execute({
    userId: DISPATCHER,
    businessId: A,
    deliveryId,
    status,
    reasonId: REASON,
  });

describe("undoing a mistaken 'Em rota' on a route that has not left", () => {
  it("keeps the stop on the plan and the delivery with its driver", async () => {
    const corrected = await seedDelivery("Corrigida");
    const other = await seedDelivery("Outra");

    const route = await context.create.execute({
      userId: DISPATCHER,
      businessId: A,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date("2026-09-25T08:00:00.000Z"),
      deliveryIds: [corrected, other],
    });

    await context.release.execute({
      userId: DISPATCHER,
      businessId: A,
      routeId: route.id,
    });

    // The mistake, and its correction.
    await setStatus(corrected, "IN_TRANSIT");
    await setStatus(corrected, "PENDING");

    const stops = context.routeRepository.stops.filter(
      (stop) => stop.deliveryId === corrected,
    );

    // Before the fix: the stop was deleted and the shadow cleared — the
    // document silently left tomorrow's route and the driver's phone.
    expect(stops, "a parada saiu do plano").toHaveLength(1);
    expect(stops[0].routeId).toBe(route.id);
    expect(stops[0].status).toBe("PENDING");

    const delivery = context.deliveryRepository.deliveries.find(
      (entry) => entry.id === corrected,
    )!;

    expect(delivery.status).toBe("PENDING");
    expect(delivery.driverId).toBe(DRIVER);
    expect(delivery.vehicleId).toBe(VEHICLE);

    // Nobody is told they lost an address they did not lose.
    const removed = context.published.filter(
      (event) =>
        event.topic === "delivery.status_overridden" &&
        event.payload.removedFromWorklist === true,
    );

    expect(removed).toHaveLength(0);
  });
});
