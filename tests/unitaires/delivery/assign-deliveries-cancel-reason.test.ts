import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
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
 * What the driver of a route emptied by a reassignment is told (IDEMP-05
 * review).
 *
 * The cancellation reason is the body of the push on the driver's lock
 * screen ("Rota 12: <motivo>"). Moving João's documents to Maria empties his
 * released route, and "redesignadas para outro motorista" is the truth. But
 * the same shortcut also swaps the TRUCK for the same driver — his documents
 * go to a new route of his own — and telling him they went to somebody else
 * is a false alarm that sends him to the phone.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000002b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000002aa";

const JOAO = "018f0000-0000-7000-8000-0000000002d1";
const MARIA = "018f0000-0000-7000-8000-0000000002d2";

const TRUCK_1 = "018f0000-0000-7000-8000-0000000002e1";
const TRUCK_2 = "018f0000-0000-7000-8000-0000000002e2";

const SHIPPER = "018f0000-0000-7000-8000-0000000002f1";

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

  const notificationService = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();

  routeRepository.vehicles = vehicleRepository.vehicles;

  userRepository.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  driverRepository.drivers.push(
    {
      id: JOAO,
      name: "João",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
    {
      id: MARIA,
      name: "Maria",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
  );

  vehicleRepository.vehicles.push(
    {
      id: TRUCK_1,
      license_plate: "CCC3C33",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
    {
      id: TRUCK_2,
      license_plate: "DDD4D44",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
  );

  const useCase = new AssignDeliveriesUseCase(
    userRepository,
    routeRepository,
    new CreateRouteUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),
    new ReleaseRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      notificationService,
      outbox,
      webhooks.asService(),
    ),
    new CancelRouteUseCase(
      routeRepository,
      userRepository,
      notificationService,
      outbox,
      webhooks.asService(),
    ),
    new UpdateRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),
  );

  return { useCase, deliveryRepository, published };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    recipient_name: "Cliente",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER,
  } as CreateDeliveryProps);

  return created.id!;
}

const assign = (deliveryIds: string[], driverId: string, vehicleId: string) =>
  context.useCase.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    deliveryIds,
    driverId,
    vehicleId,
  });

const cancellationReasons = () =>
  context.published
    .filter((event) => event.topic === "route.cancelled")
    .map((event) => String(event.payload.reason));

describe("the reason on the push of an emptied route", () => {
  it("says the documents went to another driver when they did", async () => {
    const delivery = await seedDelivery();

    await assign([delivery], JOAO, TRUCK_1);
    await assign([delivery], MARIA, TRUCK_2);

    const reasons = cancellationReasons();

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/outro motorista/);
  });

  it("does not tell the driver he lost them when only the truck changed", async () => {
    const delivery = await seedDelivery();

    await assign([delivery], JOAO, TRUCK_1);
    await assign([delivery], JOAO, TRUCK_2);

    const reasons = cancellationReasons();

    expect(reasons).toHaveLength(1);

    // Before: "Todas as paradas foram redesignadas para outro motorista." —
    // on the lock screen of the driver who still has every one of them.
    expect(reasons[0], "motivo falso no push").not.toMatch(/outro motorista/);
  });
});
