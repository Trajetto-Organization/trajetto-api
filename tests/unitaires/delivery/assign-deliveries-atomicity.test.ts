import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
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
 * The batch assignment as ONE unit of work (IDEMP-05).
 *
 * It used to be three commits: the detach (which emptied the previous route),
 * then create-route (which only then checked the driver, the vehicle and the
 * deliveries), then the release. A refusal in the second step answered 400
 * over a first step that had already committed — the documents gone from the
 * previous driver's route, the error saying nothing changed. And a resend of
 * an assignment that had succeeded rebuilt it: a second route, a second
 * "rota liberada", the first route left RELEASED and empty.
 *
 * The transaction is a sentinel object here, handed to every write by the
 * mocked `$transaction`, so "one unit of work" is something a test can see.
 */
const { TX, transaction } = vi.hoisted(() => {
  const TX = { sentinel: "assignment-tx" };

  return {
    TX,
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(TX),
    ),
  };
});

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (run: (tx: unknown) => Promise<unknown>) => transaction(run),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";

const USER_ID = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";

const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000ab";

const VEHICLE_ID = "018f0000-0000-7000-8000-0000000000e1";
const OTHER_VEHICLE_ID = "018f0000-0000-7000-8000-0000000000e2";

const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

function makeContext() {
  const published: Array<{ topic: string }> = [];

  const outbox = {
    publish: async (_tx: unknown, event: { topic: string }) => {
      published.push({ topic: event.topic });
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

  userRepository.user.push(
    { id: USER_ID, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER_ID,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
  );

  driverRepository.drivers.push(
    {
      id: DRIVER_ID,
      name: "João Motorista",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
    {
      id: OTHER_DRIVER_ID,
      name: "Maria Motorista",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Driver,
  );

  vehicleRepository.vehicles.push(
    {
      id: VEHICLE_ID,
      license_plate: "ABC1D23",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
    {
      id: OTHER_VEHICLE_ID,
      license_plate: "XYZ9K87",
      status: "ACTIVE",
      businessId: BUSINESS,
    } as Vehicle,
  );

  const createRoute = new CreateRouteUseCase(
    routeRepository,
    userRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    notificationService,
    webhooks.asService(),
  );

  const releaseRoute = new ReleaseRouteUseCase(
    routeRepository,
    userRepository,
    driverRepository,
    notificationService,
    outbox,
    webhooks.asService(),
  );

  const cancelRoute = new CancelRouteUseCase(
    routeRepository,
    userRepository,
    notificationService,
    outbox,
    webhooks.asService(),
  );

  const startRoute = new StartRouteUseCase(
    routeRepository,
    userRepository,
    vehicleRepository,
    notificationService,
    outbox,
    webhooks.asService(),
  );

  const useCase = new AssignDeliveriesUseCase(
    userRepository,
    routeRepository,
    createRoute,
    releaseRoute,
    cancelRoute,
    new UpdateRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhooks.asService(),
    ),
  );

  return {
    useCase,
    startRoute,
    createRoute,
    releaseRoute,
    cancelRoute,
    routeRepository,
    deliveryRepository,
    driverRepository,
    vehicleRepository,
    published,
    webhooks,
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  transaction.mockClear();
  context = makeContext();
});

async function seedDelivery(recipient = "Cliente A"): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    recipient_name: recipient,
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
  } as CreateDeliveryProps);

  return created.id!;
}

const assign = (
  deliveryIds: string[],
  driverId = DRIVER_ID,
  vehicleId = VEHICLE_ID,
) =>
  context.useCase.execute({
    userId: USER_ID,
    businessId: BUSINESS,
    deliveryIds,
    driverId,
    vehicleId,
  });

const deliveryFor = (id: string) =>
  context.deliveryRepository.deliveries.find((entry) => entry.id === id)!;

const routeFor = (id: string) =>
  context.routeRepository.routes.find((route) => route.id === id)!;

const stopsOn = (routeId: string) =>
  context.routeRepository.stops.filter((stop) => stop.routeId === routeId);

const vehicleFor = (id: string) =>
  context.vehicleRepository.vehicles.find((entry) => entry.id === id)!;

describe("a refused reassignment changes nothing", () => {
  it("keeps the previous route when the new vehicle is out of operation", async () => {
    const delivery = await seedDelivery();
    const first = await assign([delivery]);

    // Blocked between the dialog opening and the dispatcher confirming.
    vehicleFor(OTHER_VEHICLE_ID).status = "BLOCKED";

    await expect(
      assign([delivery], OTHER_DRIVER_ID, OTHER_VEHICLE_ID),
    ).rejects.toMatchObject({ code: "ROUTE_VEHICLE_UNAVAILABLE" });

    // Before: 400 to the dispatcher, and the stop already gone from João's
    // route — the document back in the unassigned pool with no one told.
    expect(
      stopsOn(first.routeId),
      "a rota anterior perdeu a parada",
    ).toHaveLength(1);
    expect(routeFor(first.routeId).status).toBe("RELEASED");
    expect(deliveryFor(delivery).driverId).toBe(DRIVER_ID);
    expect(deliveryFor(delivery).vehicleId).toBe(VEHICLE_ID);
  });

  it("keeps the previous route when the new driver is inactive", async () => {
    const delivery = await seedDelivery();
    const first = await assign([delivery]);

    context.driverRepository.drivers.find(
      (driver) => driver.id === OTHER_DRIVER_ID,
    )!.status = "INACTIVE";

    await expect(
      assign([delivery], OTHER_DRIVER_ID, OTHER_VEHICLE_ID),
    ).rejects.toMatchObject({ code: "ROUTE_DRIVER_INACTIVE" });

    expect(stopsOn(first.routeId)).toHaveLength(1);
    expect(deliveryFor(delivery).driverId).toBe(DRIVER_ID);
  });

  it("keeps every stop when one delivery of the selection is no longer routable", async () => {
    const first = await seedDelivery("Cliente A");
    const second = await seedDelivery("Cliente B");

    const assigned = await assign([first, second]);

    // Cancelled on another screen while this one was open.
    deliveryFor(second).status = "CANCELLED";

    await expect(
      assign([first, second], OTHER_DRIVER_ID, OTHER_VEHICLE_ID),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_ROUTABLE" });

    // Before: the cancelled one sank the batch AFTER both stops had left
    // João's route.
    expect(stopsOn(assigned.routeId)).toHaveLength(2);
    expect(deliveryFor(first).driverId).toBe(DRIVER_ID);
  });
});

describe("the reassignment is one unit of work", () => {
  it("detaches, builds and releases inside a single transaction", async () => {
    const delivery = await seedDelivery();

    await assign([delivery]);

    transaction.mockClear();

    const detach = vi.spyOn(context.routeRepository, "detachFromOpenRoutes");
    const create = vi.spyOn(context.routeRepository, "createRoute");
    const transition = vi.spyOn(context.routeRepository, "transitionRoute");

    await assign([delivery], OTHER_DRIVER_ID, OTHER_VEHICLE_ID);

    // Before: three transactions (the detach's own, create-route's and
    // release-route's), so a failure in the last two could not undo the first.
    expect(transaction).toHaveBeenCalledTimes(1);

    // The in-memory fake ignores the transaction argument, so it is read off
    // the raw call: what matters is that every write was HANDED the same one.
    const txOf = (calls: unknown[][], index: number) =>
      calls.map((call) => call[index]);

    expect(detach).toHaveBeenCalledWith([delivery], BUSINESS, TX);
    expect(txOf(create.mock.calls as unknown[][], 1)).toEqual([TX]);
    expect(transition.mock.calls.length).toBeGreaterThan(0);
    expect(
      txOf(transition.mock.calls as unknown[][], 3).every((tx) => tx === TX),
    ).toBe(true);
  });
});

describe("a resend of an assignment that already happened", () => {
  it("answers with the route it created instead of building another", async () => {
    const first = await seedDelivery("Cliente A");
    const second = await seedDelivery("Cliente B");

    const once = await assign([first, second]);

    // The response of the first call was lost; the dialog is still open and
    // the dispatcher presses Confirmar again.
    const twice = await assign([second, first]);

    expect(twice.routeId).toBe(once.routeId);
    expect(twice.routeCode).toBe(once.routeCode);
    expect(twice.assigned).toBe(2);

    // Before: a second route, the first one RELEASED and empty, and the driver
    // woken twice by "rota liberada".
    expect(context.routeRepository.routes).toHaveLength(1);
    expect(
      context.published.filter((event) => event.topic === "route.released"),
    ).toHaveLength(1);

    const assignedEvents = context.webhooks.announced.filter(
      (event) => event.topic === "delivery.assigned",
    );

    expect(assignedEvents).toHaveLength(2);
    expect(
      context.webhooks.announced.filter(
        (event) => event.topic === "route.released",
      ),
    ).toHaveLength(1);
  });

  it("still rebuilds when the same documents go to a different driver", async () => {
    const delivery = await seedDelivery();

    const once = await assign([delivery]);
    const moved = await assign([delivery], OTHER_DRIVER_ID, OTHER_VEHICLE_ID);

    expect(moved.routeId).not.toBe(once.routeId);
    expect(routeFor(moved.routeId).driverId).toBe(OTHER_DRIVER_ID);
  });
});

describe("the route a reassignment empties", () => {
  it("is cancelled rather than left released with nothing on it", async () => {
    const delivery = await seedDelivery();

    const first = await assign([delivery]);
    await assign([delivery], OTHER_DRIVER_ID, OTHER_VEHICLE_ID);

    // Before: RELEASED with zero stops — a promise to João that meant
    // nothing, startable into a route that could never close.
    expect(routeFor(first.routeId).status).toBe("CANCELLED");
    expect(routeFor(first.routeId).cancellation_reason).toBeTruthy();

    // João hears it the way he heard the release.
    expect(
      context.published.filter((event) => event.topic === "route.cancelled"),
    ).toHaveLength(1);
  });

  it("does not free the truck when that route never left", async () => {
    // João's truck is out on another route while tomorrow's, on the same
    // truck, is released. Emptying tomorrow's must not mark the truck free.
    const onTheRoad = await seedDelivery("Na rua");
    const tomorrow = await seedDelivery("Amanhã");

    const out = await assign([onTheRoad]);

    await context.startRoute.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      routeId: out.routeId,
    });

    expect(vehicleFor(VEHICLE_ID).status).toBe("IN_ROUTE");

    const released = await assign([tomorrow]);

    await assign([tomorrow], OTHER_DRIVER_ID, OTHER_VEHICLE_ID);

    expect(routeFor(released.routeId).status).toBe("CANCELLED");
    expect(
      vehicleFor(VEHICLE_ID).status,
      "caminhão na rua marcado como livre",
    ).toBe("IN_ROUTE");
  });
});

describe("cancelling a route that never left", () => {
  it("leaves the truck out when it is on another route", async () => {
    const onTheRoad = await seedDelivery("Na rua");
    const tomorrow = await seedDelivery("Amanhã");

    const out = await assign([onTheRoad]);

    await context.startRoute.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      routeId: out.routeId,
    });

    const released = await assign([tomorrow]);

    await context.cancelRoute.execute({
      userId: USER_ID,
      businessId: BUSINESS,
      routeId: released.routeId,
      reason: "Replanejada",
    });

    // Before: any CANCELLED route moved its vehicle IN_ROUTE → ACTIVE, even
    // one that never took it out, so the truck on the road read as free.
    expect(vehicleFor(VEHICLE_ID).status).toBe("IN_ROUTE");
  });
});
