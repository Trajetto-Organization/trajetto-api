import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";

import { RegisterDeliveryArrivalUseCase } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-usecase";
import { RegisterDeliveryProofUseCase } from "@/modules/delivery/usecases/register-delivery-proof/register-delivery-proof-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * The route and the deliveries on it, as one moving thing.
 *
 * Nobody presses a button to resolve a stop. The driver acts on a DELIVERY —
 * arrived, proved it, reported a problem — and the stop is the route's view of
 * that same act; the route ends because its last stop did. So none of this can
 * be tested from the route module alone: these tests drive the delivery use
 * cases the app actually calls and then look at what happened to the route.
 *
 * Both repositories share ONE delivery store, because in Postgres they share
 * one table. With two stores a departure could mark deliveries IN_TRANSIT in a
 * copy nobody reads, and every test here would pass while the driver's app was
 * refused at the first address.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";

const DISPATCHER_A = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER_A = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_USER_B = "018f0000-0000-7000-8000-0000000000b2";

const DRIVER_A = "018f0000-0000-7000-8000-0000000000d1";
const DRIVER_B = "018f0000-0000-7000-8000-0000000000d2";

const VEHICLE_A = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const BLOCKING_TYPE = "018f0000-0000-7000-8000-0000000000c1";
const INFO_TYPE = "018f0000-0000-7000-8000-0000000000c2";

const TODAY = new Date("2026-09-15T08:00:00.000Z");

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

// The presigned PUT already happened; the stub answers as the bucket would
// for keys this business owns.
const uploadService = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const outbox = { publish: async () => undefined } as unknown as OutboxService;

function makeContext() {
  const deliveryRepository = new InMemoryDeliveryRepository();

  // One store, shared. See the file docblock.
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();
  const occurrenceTypeRepository = new InMemoryOccurrenceTypeRepository();

  userRepository.user.push(
    { id: DISPATCHER_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    {
      id: DRIVER_USER_A,
      name: "João",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_A,
    } as User,
    {
      id: DRIVER_USER_B,
      name: "Maria",
      role: "BUSINESS_USER",
      businessId: B,
      driverId: DRIVER_B,
    } as User,
  );

  driverRepository.drivers.push(
    {
      id: DRIVER_A,
      name: "João",
      status: "ACTIVE",
      businessId: A,
    } as Driver,
    {
      id: DRIVER_B,
      name: "Maria",
      status: "ACTIVE",
      businessId: B,
    } as Driver,
  );

  vehicleRepository.vehicles.push({
    id: VEHICLE_A,
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: A,
  } as Vehicle);

  occurrenceTypeRepository.occurrenceTypes.push(
    {
      id: BLOCKING_TYPE,
      name: "Cliente ausente",
      businessId: A,
      is_active: true,
      blocks_delivery: true,
      requires_photo: false,
    } as OccurrenceType,
    {
      id: INFO_TYPE,
      name: "Trânsito intenso",
      businessId: A,
      is_active: true,
      blocks_delivery: false,
      requires_photo: false,
    } as OccurrenceType,
  );

  return {
    routeRepository,
    deliveryRepository,
    userRepository,
    occurrenceTypeRepository,

    create: new CreateRouteUseCase(
      routeRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
    ),
    release: new ReleaseRouteUseCase(
      routeRepository,
      driverRepository,
      notificationService,
    ),
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
    ),
    cancel: new CancelRouteUseCase(routeRepository, notificationService),

    arrival: new RegisterDeliveryArrivalUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
    ),
    proof: new RegisterDeliveryProofUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      uploadService,
    ),
    occurrence: new ReportDeliveryOccurrenceUseCase(
      userRepository,
      occurrenceTypeRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      uploadService,
      outbox,
    ),
    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;
let submissionCounter: number;

beforeEach(() => {
  context = makeContext();
  submissionCounter = 0;
});

/** A fresh idempotency key, so a test only replays when it means to. */
function submission(): string {
  submissionCounter += 1;

  return `018f0000-0000-7000-8000-0000000e${String(submissionCounter).padStart(
    4,
    "0",
  )}`;
}

async function seedDelivery(
  businessId = A,
  recipient = "Destinatário",
): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId,
    shipperId: SHIPPER,
    recipient_name: recipient,
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

/** Create → release → start, which is how every route reaches the street. */
async function runningRoute(deliveryIds: string[]): Promise<string> {
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

  await context.start.execute({
    userId: DRIVER_USER_A,
    businessId: A,
    routeId: route.id,
  });

  return route.id;
}

function stopFor(deliveryId: string) {
  return context.routeRepository.stops.filter(
    (stop) => stop.deliveryId === deliveryId,
  );
}

function deliveryFor(deliveryId: string) {
  return context.deliveryRepository.deliveries.find(
    (entry) => entry.id === deliveryId,
  )!;
}

function routeFor(routeId: string) {
  return context.routeRepository.routes.find((route) => route.id === routeId)!;
}

describe("a day on a route, end to end", () => {
  it("plans, releases, leaves, works both addresses and closes itself", async () => {
    const first = await seedDelivery(A, "Cliente A");
    const second = await seedDelivery(A, "Cliente B");

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [first, second],
    });

    // Planning designates but does not dispatch: the panel has to show who the
    // load is for, and nothing is on the street yet.
    expect(route.status).toBe("PLANNED");
    expect(route.stops).toHaveLength(2);
    expect(route.stops.every((stop) => stop.status === "PENDING")).toBe(true);
    expect(deliveryFor(first).status).toBe("PENDING");
    expect(deliveryFor(first).driverId).toBe(DRIVER_A);

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    expect(routeFor(route.id).status).toBe("RELEASED");
    expect(deliveryFor(first).status).toBe("PENDING");

    await context.start.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      routeId: route.id,
    });

    // The departure IS what puts the load on the street. Without this the
    // driver's next action is refused with DELIVERY_NOT_IN_TRANSIT, and the
    // route would be a dead end for the app.
    expect(routeFor(route.id).status).toBe("IN_PROGRESS");
    expect(deliveryFor(first).status).toBe("IN_TRANSIT");
    expect(deliveryFor(second).status).toBe("IN_TRANSIT");

    await context.arrival.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: first,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    });

    expect(stopFor(first)[0].status).toBe("ARRIVED");
    expect(stopFor(first)[0].arrived_at).not.toBeNull();

    // Arriving resolves nothing: the route is still running.
    expect(routeFor(route.id).status).toBe("IN_PROGRESS");

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: first,
      client_submission_id: submission(),
      photo: "canhoto-1.jpg",
      received_by: "Porteiro",
    });

    expect(stopFor(first)[0].status).toBe("COMPLETED");
    expect(stopFor(first)[0].completed_at).not.toBeNull();
    expect(deliveryFor(first).status).toBe("DELIVERED");

    // One address left, so the route keeps running.
    expect(routeFor(route.id).status).toBe("IN_PROGRESS");

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: second,
      client_submission_id: submission(),
      photo: "canhoto-2.jpg",
    });

    // Nobody pressed "encerrar rota". The route ended because its last stop
    // did — which is why there is no endpoint for it.
    expect(routeFor(route.id).status).toBe("COMPLETED");
    expect(routeFor(route.id).completed_at).not.toBeNull();
  });
});

describe("proving an address the driver never announced arriving at", () => {
  it("settles the stop straight from PENDING", async () => {
    // Deliberate, not an oversight: the app lets a driver prove a delivery
    // without announcing the arrival first, and a whole street worked with no
    // signal reaches the server as proofs with no arrivals in front of them.
    // Refusing this would make the outbox reject real work.
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(stopFor(delivery)[0].status).toBe("COMPLETED");
    expect(stopFor(delivery)[0].arrived_at).toBeNull();
    expect(routeFor(route).status).toBe("COMPLETED");
  });

  it("keeps the first arrival's timestamp when the driver announces twice", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    await context.arrival.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    });

    const firstArrival = stopFor(delivery)[0].arrived_at;

    // A different submission id, so this is a second genuine call rather than
    // an outbox replay — the app can send one if the driver taps again.
    await context.arrival.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    });

    // The stop only moves from PENDING, so the time the driver actually got
    // there survives. Two ARRIVAL events, one arrival time.
    expect(stopFor(delivery)[0].arrived_at).toBe(firstArrival);
    expect(context.deliveryRepository.events).toHaveLength(2);
  });

  it("records the arrival once however often the outbox resends it", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const request = {
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    };

    await context.arrival.execute(request);
    await context.arrival.execute(request);
    await context.arrival.execute(request);

    expect(context.deliveryRepository.events).toHaveLength(1);
    expect(stopFor(delivery)[0].status).toBe("ARRIVED");
  });
});

describe("an insucesso is a result, not an interruption", () => {
  it("fails the stop and lets the route finish", async () => {
    const failing = await seedDelivery(A, "Ausente");
    const other = await seedDelivery(A, "Presente");

    const route = await runningRoute([failing, other]);

    await context.occurrence.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: failing,
      occurrenceTypeId: BLOCKING_TYPE,
      description: "Ninguém atendeu",
      client_submission_id: submission(),
    });

    expect(deliveryFor(failing).status).toBe("FAILED");
    expect(stopFor(failing)[0].status).toBe("FAILED");
    expect(stopFor(failing)[0].completed_at).not.toBeNull();

    // A failed address still resolves the stop, so the route can end on it.
    expect(routeFor(route).status).toBe("IN_PROGRESS");

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: other,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(routeFor(route).status).toBe("COMPLETED");
  });

  it("leaves the stop open for an occurrence that does not block", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await context.occurrence.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: INFO_TYPE,
      description: "Trânsito na marginal",
      client_submission_id: submission(),
    });

    // Informational occurrences are trail entries. The driver is still going
    // to that address, so closing the route here would be a lie.
    expect(deliveryFor(delivery).status).toBe("IN_TRANSIT");
    expect(stopFor(delivery)[0].status).toBe("PENDING");
    expect(routeFor(route).status).toBe("IN_PROGRESS");
  });
});

describe("the panel resolving an address the driver never reached", () => {
  it("cancels the stop and closes the route behind it", async () => {
    // The customer called the office and cancelled. If the stop did not learn
    // about it, the route would wait forever for an address nobody is going
    // to visit.
    const cancelled = await seedDelivery(A, "Desistiu");
    const route = await runningRoute([cancelled]);

    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: cancelled,
      status: "CANCELLED",
    });

    expect(deliveryFor(cancelled).status).toBe("CANCELLED");
    expect(stopFor(cancelled)[0].status).toBe("CANCELLED");
    expect(routeFor(route).status).toBe("COMPLETED");
  });

  it("completes the stop when the office marks the delivery delivered", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: delivery,
      status: "DELIVERED",
      received_by: "Recebido no balcão",
    });

    expect(stopFor(delivery)[0].status).toBe("COMPLETED");
    expect(routeFor(route).status).toBe("COMPLETED");
  });
});

describe("re-delivery keeps the record of the attempt", () => {
  it("opens a new stop on a new route and never touches the failed one", async () => {
    const delivery = await seedDelivery(A, "Segunda tentativa");
    const firstRoute = await runningRoute([delivery]);

    await context.occurrence.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
    });

    const failedStop = stopFor(delivery)[0];

    expect(failedStop.status).toBe("FAILED");
    expect(routeFor(firstRoute).status).toBe("COMPLETED");

    // Back to the pool for another day. The stop that failed is the record of
    // an attempt that happened, so it must NOT reopen.
    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: delivery,
      status: "PENDING",
    });

    expect(stopFor(delivery)).toHaveLength(1);
    expect(stopFor(delivery)[0].status).toBe("FAILED");
    expect(stopFor(delivery)[0].routeId).toBe(firstRoute);

    const secondRoute = await runningRoute([delivery]);

    // Two stops now, on two routes: yesterday's attempt and today's.
    const stops = stopFor(delivery);

    expect(stops).toHaveLength(2);
    expect(stops.map((stop) => stop.status).sort()).toEqual([
      "FAILED",
      "PENDING",
    ]);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    const [attempt, success] = stopFor(delivery).sort((left, right) =>
      left.routeId === firstRoute ? -1 : right.routeId === firstRoute ? 1 : 0,
    );

    expect(attempt.status).toBe("FAILED");
    expect(attempt.routeId).toBe(firstRoute);
    expect(success.status).toBe("COMPLETED");
    expect(success.routeId).toBe(secondRoute);
  });

  it("refuses a delivery that is already out on the street", async () => {
    // The first refusal the dispatcher meets, and the one worth meeting: it
    // names the situation. The index below is the net underneath it.
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        scheduled_date: TODAY,
        deliveryIds: [delivery],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DELIVERY_NOT_ROUTABLE",
    });
  });

  it("refuses a delivery already promised to a planned route", async () => {
    // R1, as the partial unique index states it: one open stop per delivery.
    // This is the case where the index is the ONLY defence — the delivery is
    // still PENDING, so the status guard above waves it through, and the
    // second route is what would let it be worked (and proven) twice.
    const delivery = await seedDelivery();

    await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    expect(deliveryFor(delivery).status).toBe("PENDING");

    await expect(
      context.create.execute({
        userId: DISPATCHER_A,
        businessId: A,
        driverId: DRIVER_A,
        scheduled_date: TODAY,
        deliveryIds: [delivery],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_ALREADY_ON_ROUTE",
    });

    // Nothing half-created: a route the dispatcher would have to find and undo
    // is worse than no route.
    expect(context.routeRepository.routes).toHaveLength(1);
  });
});

describe("cancelling a route that already left", () => {
  it("cancels its open stops and sends the load back to the pool", async () => {
    const delivered = await seedDelivery(A, "Já entregue");
    const pending = await seedDelivery(A, "Não visitada");

    const route = await runningRoute([delivered, pending]);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivered,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route,
      reason: "Caminhão quebrou na marginal",
    });

    expect(routeFor(route).status).toBe("CANCELLED");

    // What was proven this morning was proven, whatever happened afterwards.
    expect(stopFor(delivered)[0].status).toBe("COMPLETED");
    expect(deliveryFor(delivered).status).toBe("DELIVERED");
    expect(deliveryFor(delivered).driverId).toBe(DRIVER_A);

    // What never got visited goes back where it came from — status AND
    // ownership. A delivery left IN_TRANSIT with a driver who is not driving
    // shows up on the app of somebody who cannot do anything about it, and a
    // stop left PENDING keeps it locked out of every future route.
    expect(stopFor(pending)[0].status).toBe("CANCELLED");
    expect(deliveryFor(pending).status).toBe("PENDING");
    expect(deliveryFor(pending).driverId).toBeNull();
    expect(deliveryFor(pending).vehicleId).toBeNull();
  });

  it("lets the returned delivery go straight onto another route", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route,
      reason: "Motorista passou mal",
    });

    // The whole point of cancelling the open stops: without it the partial
    // unique index would keep this delivery reserved by a route that no longer
    // exists, invisibly, forever.
    const replacement = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    expect(replacement.stops).toHaveLength(1);
    expect(replacement.stops[0].status).toBe("PENDING");
  });
});

describe("a delivery that is not on a route at all", () => {
  it("is proven normally, with nothing to settle", async () => {
    // Most deliveries in this product were never on a route — assigned in a
    // batch, imported from a spreadsheet. Settling answers null for them, and
    // a route with nothing to say must not sink a proof.
    const delivery = await seedDelivery();

    deliveryFor(delivery).driverId = DRIVER_A;
    deliveryFor(delivery).status = "IN_TRANSIT";

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(deliveryFor(delivery).status).toBe("DELIVERED");
    expect(context.routeRepository.stops).toHaveLength(0);
  });
});

describe("the other carrier at the moment of settlement", () => {
  it("cannot resolve a stop by reporting on a delivery that is not its own", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await expect(
      context.occurrence.execute({
        userId: DRIVER_USER_B,
        businessId: B,
        deliveryId: delivery,
        occurrenceTypeId: BLOCKING_TYPE,
        client_submission_id: submission(),
      }),
    ).rejects.toThrow();

    // Refused before anything was written, and the route carries on.
    expect(stopFor(delivery)[0].status).toBe("PENDING");
    expect(deliveryFor(delivery).status).toBe("IN_TRANSIT");
    expect(routeFor(route).status).toBe("IN_PROGRESS");
    expect(context.deliveryRepository.occurrences).toHaveLength(0);
  });

  it("cannot resolve it from the panel either", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await expect(
      context.setStatus.execute({
        userId: DRIVER_USER_B,
        businessId: B,
        deliveryId: delivery,
        status: "CANCELLED",
      }),
    ).rejects.toThrow();

    expect(stopFor(delivery)[0].status).toBe("PENDING");
    expect(routeFor(route).status).toBe("IN_PROGRESS");
  });
});
