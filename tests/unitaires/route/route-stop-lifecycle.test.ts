import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyProofUseCase,
  businessWithoutAI as reportsWithoutAI,
} from "../../support/delivery-proof-usecases";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { CancelRouteUseCase } from "@/modules/route/usecases/cancel-route/cancel-route-usecase";

import { RegisterDeliveryArrivalUseCase } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import { StartDriverRouteUseCase } from "@/modules/delivery/usecases/start-driver-route/start-driver-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
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

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

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
const REASON = "018f0000-0000-7000-8000-0000000000e9";
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

/**
 * The audit queue and the company row the proof use case reaches for.
 *
 * The queue is a real fake: the card it writes is what the office opens, and a
 * stub that swallowed the call would let a test prove a proof queues an audit
 * when it queues nothing.
 *
 * The business answers `ai_analysis_limit: 0` — this company did not buy the
 * AI. The card still queues, which is the behaviour that matters: a receipt
 * whose analysis never ran must still reach a person.
 */
const proofAuditRepository = new InMemoryProofAuditRepository();

const businessWithoutAI = {
  findBusinessById: async () => ({ ai_analysis_limit: 0 }),
} as unknown as IBusinessRepository;

function makeContext() {
  /**
   * Records instead of discarding: the outbox is the only way a use case is
   * allowed to reach a driver, so what it received IS the notification
   * behaviour under test.
   */
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];

  const outboxStub = {
    publish: async (
      _tx: unknown,
      event: { topic: string; payload: Record<string, unknown> },
    ) => {
      published.push({ topic: event.topic, payload: event.payload });
    },
  } as unknown as OutboxService;

  /**
   * Records too, and for a sharper reason: an integration that is told
   * a route closed when it did not — or is never told when it did — is a
   * customer's ERP left holding a truck that is already back at the
   * depot. Fresh per context, so one test cannot read another's events.
   */
  const webhookStub = new InMemoryWebhookFanOutService();

  const deliveryRepository = new InMemoryDeliveryRepository();

  // One store, shared, in both directions. See the file docblock.
  const reasonRepository = new InMemoryStatusChangeReasonRepository();

  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

  // The panel cannot move a status without saying why. One active reason is
  // what makes these tests exercise the change rather than the refusal.
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

  // The route owns Vehicle.status while the truck is out, so it has to see
  // the same rows the vehicle fake serves.
  routeRepository.vehicles = vehicleRepository.vehicles;

  vehicleRepository.vehicles.push({
    id: VEHICLE_A,
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: A,
    driverId: DRIVER_A,
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
    published,
    webhookStub,
    routeRepository,
    deliveryRepository,
    userRepository,
    occurrenceTypeRepository,

    create: new CreateRouteUseCase(
      routeRepository,
      userRepository,
      deliveryRepository,
      driverRepository,
      vehicleRepository,
      notificationService,
      webhookStub.asService(),
    ),
    release: new ReleaseRouteUseCase(
      routeRepository,
      userRepository,
      driverRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),
    cancel: new CancelRouteUseCase(
      routeRepository,
      userRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),

    arrival: new RegisterDeliveryArrivalUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      webhookStub.asService(),
    ),
    proof: legacyProofUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      outboxStub,
      proofAuditRepository,
      businessWithoutAI,
      uploadService,
      webhookStub.asService(),
    ),
    occurrence: new ReportDeliveryOccurrenceUseCase(
      userRepository,
      occurrenceTypeRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      uploadService,
      outboxStub,
      webhookStub.asService(),
      new InMemoryOccurrenceAuthorizationRepository(
        deliveryRepository,
        occurrenceTypeRepository,
        userRepository,
      ),
      new InMemoryProofAuditRepository(),
      reportsWithoutAI,
    ),
    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      reasonRepository,
      notificationService,
      outboxStub,
      webhookStub.asService(),
    ),

    vehicleRepository,

    /** Takes the driver's truck away, for the guard that asks about one. */
    unlinkVehicleFromDriver: () => {
      for (const vehicle of vehicleRepository.vehicles) {
        vehicle.driverId = null;
      }
    },

    // The endpoint the phones in the field still call.
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
      reasonId: REASON,
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
      reasonId: REASON,
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
      reasonId: REASON,
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
        reasonId: REASON,
      }),
    ).rejects.toThrow();

    expect(stopFor(delivery)[0].status).toBe("PENDING");
    expect(routeFor(route).status).toBe("IN_PROGRESS");
  });
});

describe("the departure endpoint the phones already have", () => {
  /**
   * `POST /start-route/:businessId` predates the route entity. Queued
   * submissions in the field still point at it, so it stays — as an adapter.
   * What it must never do is become a second, competing departure.
   */
  it("never starts the driver's released route (IDEMP-17)", async () => {
    // The app calls this door only when it shows no route, so a route found
    // here is one the tap never saw. It leaves through its own endpoint — one
    // departure in the system, and only the one that names the route.
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

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    expect(routeFor(route.id).status).toBe("RELEASED");
    expect(routeFor(route.id).started_at).toBeNull();
    expect(result.started).toBe(0);
    expect(deliveryFor(first).status).toBe("PENDING");
  });

  it("answers started = 0 on the resend rather than failing", async () => {
    const delivery = await seedDelivery();
    const routeId = await runningRoute([delivery]);

    // The app classifies a 4xx as permanent and would park a departure that
    // did happen on the pending screen.
    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    expect(result.started).toBe(0);
    expect(routeFor(routeId).status).toBe("IN_PROGRESS");
  });

  it("refuses to dispatch a route the dispatcher never released", async () => {
    // The hazard of the two models coexisting: a delivery on a PLANNED route
    // already carries the driver's id, because that is the route's shadow. The
    // old batch matched on exactly that, so one tap would have put tomorrow's
    // plan on the street with the route still reading PLANNED.
    const delivery = await seedDelivery();

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    expect(result.started).toBe(0);
    expect(routeFor(route.id).status).toBe("PLANNED");
    expect(deliveryFor(delivery).status).toBe("PENDING");
  });

  it("does not blame a missing vehicle for a route that is merely planned", async () => {
    // The vehicle guard sits behind a "is there anything to start" check, and
    // that check counts PENDING deliveries. If it counted the ones sitting on
    // a planned route, a driver with no vehicle linked to their profile would
    // be told "Nenhum veículo vinculado ao seu perfil" — over a route that was
    // never released and that they were never supposed to start.
    const delivery = await seedDelivery();

    await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    // Take the truck away: nothing links this driver to a vehicle any more.
    context.unlinkVehicleFromDriver();

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    expect(result.started).toBe(0);
    expect(deliveryFor(delivery).status).toBe("PENDING");
  });

  it("still moves loose deliveries, and only those", async () => {
    // Batch assignment has not gone away, and a driver can legitimately have
    // both: a route for the morning and a couple of drops added by hand.
    const onRoute = await seedDelivery(A, "Na rota");
    const loose = await seedDelivery(A, "Avulsa");

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [onRoute],
    });

    deliveryFor(loose).driverId = DRIVER_A;

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER_A,
      businessId: A,
    });

    expect(result.started).toBe(1);
    expect(deliveryFor(loose).status).toBe("IN_TRANSIT");

    // The planned route is untouched: it leaves when it is released.
    expect(deliveryFor(onRoute).status).toBe("PENDING");
    expect(routeFor(route.id).status).toBe("PLANNED");
  });
});

describe("“Em rota” is a fact about a route, not a value somebody types", () => {
  function vehicle() {
    return context.vehicleRepository.vehicles.find(
      (entry) => entry.id === VEHICLE_A,
    )!;
  }

  it("marks the truck as out when the route leaves, and free when it ends", async () => {
    const delivery = await seedDelivery();

    expect(vehicle().status).toBe("ACTIVE");

    const route = await runningRoute([delivery]);

    expect(vehicle().status).toBe("IN_ROUTE");
    expect(routeFor(route).status).toBe("IN_PROGRESS");

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    // The route closed itself on its last stop, so the truck came back by
    // itself too. Nobody has to remember to change a dropdown.
    expect(routeFor(route).status).toBe("COMPLETED");
    expect(vehicle().status).toBe("ACTIVE");
  });

  it("frees the truck when the route is cancelled mid-way", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    expect(vehicle().status).toBe("IN_ROUTE");

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route,
      reason: "Cliente cancelou tudo",
    });

    expect(vehicle().status).toBe("ACTIVE");
  });

  it("does not reopen a truck an administrator blocked while it was out", async () => {
    // The reason both writes are conditional. A vehicle blocked BECAUSE of
    // something that happened on the road — a crash, a theft — must not be
    // quietly returned to service by the route ending.
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    expect(vehicle().status).toBe("IN_ROUTE");

    vehicle().status = "BLOCKED";

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route,
      reason: "Veículo apreendido",
    });

    expect(vehicle().status).toBe("BLOCKED");
  });

  it("refuses to depart on a truck blocked after the route was planned", async () => {
    // Between planning and the yard there is usually a night, and that is
    // where an administrator blocks a vehicle. The guard used to run only when
    // the driver swapped the truck, so the one case it exists for was the one
    // it missed.
    const delivery = await seedDelivery();

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    vehicle().status = "BLOCKED";

    await expect(
      context.start.execute({
        userId: DRIVER_USER_A,
        businessId: A,
        routeId: route.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ROUTE_VEHICLE_UNAVAILABLE",
    });

    expect(routeFor(route.id).status).toBe("RELEASED");
    expect(deliveryFor(delivery).status).toBe("PENDING");
    expect(vehicle().status).toBe("BLOCKED");
  });
});

describe("what the driver's phone is told, and what it is spared", () => {
  /**
   * Two topics, not four. A departure and a completion are facts the
   * dispatcher's board already shows the moment they happen, and both land in
   * the activity trail; a notification for each would mean sixty bells a day
   * at a company with thirty drivers, for things nobody has to act on. What
   * the driver has to act on is work arriving and work being called off.
   */
  it("rings when the route is handed over", async () => {
    const delivery = await seedDelivery();

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [delivery],
    });

    // Planning tells nobody: the route does not exist for the driver yet.
    expect(context.published).toHaveLength(0);

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    expect(context.published).toHaveLength(1);
    expect(context.published[0].topic).toBe("route.released");

    // The payload has to be self-contained: the push may render on another
    // replica seconds later, and it must not go back to the database for what
    // the route said at the time.
    expect(context.published[0].payload).toMatchObject({
      routeId: route.id,
      businessId: A,
      driverUserId: DRIVER_USER_A,
      code: route.code,
      stopCount: 1,
    });
  });

  it("stays silent when the dispatcher pulls the route back", async () => {
    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [await seedDelivery()],
    });

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      released: false,
    });

    // "Never mind" about work the driver had not started is noise.
    expect(context.published.map((event) => event.topic)).toEqual([
      "route.released",
    ]);
  });

  it("does not ring for a departure or a completion", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(routeFor(route).status).toBe("COMPLETED");

    // The release is the only thing that rang.
    expect(context.published.map((event) => event.topic)).toEqual([
      "route.released",
    ]);
  });

  it("rings urgently when a route that already left is cancelled", async () => {
    const route = await runningRoute([await seedDelivery()]);

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route,
      reason: "Cliente cancelou o pedido",
    });

    const cancellation = context.published[context.published.length - 1];

    expect(cancellation.topic).toBe("route.cancelled");
    expect(cancellation.payload).toMatchObject({
      driverUserId: DRIVER_USER_A,
      reason: "Cliente cancelou o pedido",

      // The driver may be standing at an address that was just called off, so
      // the lock screen has to read differently from a cancellation in the
      // yard.
      hadDeparted: true,
    });
  });

  it("says nothing when a route nobody was given is cancelled", async () => {
    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [await seedDelivery()],
    });

    await context.cancel.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
      reason: "Erro de planejamento",
    });

    // The driver never knew it existed.
    expect(context.published).toHaveLength(0);
  });

  it("does not ring a driver who has no login", async () => {
    // Operations that register drivers before handing out phones are real.
    // The event still fires — the trail wants it — but resolves to nobody.
    context.userRepository.user = context.userRepository.user.filter(
      (entry) => entry.id !== DRIVER_USER_A,
    );

    const route = await context.create.execute({
      userId: DISPATCHER_A,
      businessId: A,
      driverId: DRIVER_A,
      vehicleId: VEHICLE_A,
      scheduled_date: TODAY,
      deliveryIds: [await seedDelivery()],
    });

    await context.release.execute({
      userId: DISPATCHER_A,
      businessId: A,
      routeId: route.id,
    });

    expect(context.published[0].payload.driverUserId).toBeNull();
  });
});

/**
 * A route closes by ITSELF, on whichever stop happened to be last, and three
 * different use cases can be that stop. Nobody pressed a button, so nobody is
 * waiting for a response — which is exactly why the customer's ERP has to be
 * told, and why "told from two of the three paths" is a bug that hides for
 * months: the integration works, until the day a route ends on an insucesso.
 *
 * These assert the topic AND that it fires exactly once. A second
 * `route.completed` for the same route is a subscriber reopening work it
 * already closed.
 */
describe("what the customers' systems are told when a route ends", () => {
  function closures() {
    return context.webhookStub.forTopic("route.completed");
  }

  it("announces the closure when the last address is proved", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    expect(closures()).toHaveLength(0);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(closures()).toHaveLength(1);
    expect(closures()[0].businessId).toBe(A);
    expect(closures()[0].payload.route_id).toBe(route);

    // The status a subscriber reads has to be the status the route ended on.
    // Announcing the value it held before the write would have every ERP
    // recording the truck as still out.
    expect(closures()[0].payload.status).toBe("COMPLETED");
    expect(closures()[0].payload.code).toBe(routeFor(route).code);
  });

  it("announces it when the last address ends in an insucesso", async () => {
    const delivery = await seedDelivery(A, "Ausente");
    const route = await runningRoute([delivery]);

    await context.occurrence.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      description: "Ninguém atendeu",
      client_submission_id: submission(),
    });

    expect(routeFor(route).status).toBe("COMPLETED");
    expect(closures()).toHaveLength(1);
    expect(closures()[0].payload.route_id).toBe(route);
  });

  it("announces it when the panel resolves the last address", async () => {
    const delivery = await seedDelivery(A, "Desistiu");
    const route = await runningRoute([delivery]);

    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: delivery,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(routeFor(route).status).toBe("COMPLETED");
    expect(closures()).toHaveLength(1);
    expect(closures()[0].payload.route_id).toBe(route);
  });

  it("says nothing while the route still has an address to work", async () => {
    const first = await seedDelivery(A, "Cliente A");
    const second = await seedDelivery(A, "Cliente B");

    await runningRoute([first, second]);

    await context.arrival.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: first,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    });

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: first,
      client_submission_id: submission(),
      photo: "canhoto-1.jpg",
    });

    // One address down, one to go. A closure announced here is a truck the
    // customer's system releases while it is still on the street.
    expect(closures()).toHaveLength(0);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: second,
      client_submission_id: submission(),
      photo: "canhoto-2.jpg",
    });

    expect(closures()).toHaveLength(1);
  });

  it("announces the closure once, not once per replayed submission", async () => {
    const delivery = await seedDelivery();
    const route = await runningRoute([delivery]);

    const replayed = submission();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await context.proof.execute({
        userId: DRIVER_USER_A,
        businessId: A,
        deliveryId: delivery,
        client_submission_id: replayed,
        photo: "canhoto.jpg",
      });
    }

    // The outbox on a phone with no signal resends. Idempotency has to reach
    // the webhook too, or a customer's ERP sees three closures for one route.
    expect(routeFor(route).status).toBe("COMPLETED");
    expect(closures()).toHaveLength(1);
  });

  it("queues every event of a working day inside a transaction", async () => {
    // The invariant, not one instance of it. Each site passes `tx` by hand,
    // which means each site can forget — and the one that forgets is
    // invisible until a replica dies between a commit and the row that was
    // supposed to describe it. So the whole day is played and the whole
    // ledger is checked.
    const first = await seedDelivery(A, "Cliente A");
    const second = await seedDelivery(A, "Ausente");

    const route = await runningRoute([first, second]);

    await context.arrival.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: first,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
    });

    await context.setStatus.execute({
      userId: DISPATCHER_A,
      businessId: A,
      deliveryId: first,
      status: "DELIVERED",
      received_by: "Balcão",
      reasonId: REASON,
    });

    await context.occurrence.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: second,
      occurrenceTypeId: BLOCKING_TYPE,
      description: "Ninguém atendeu",
      client_submission_id: submission(),
    });

    expect(routeFor(route).status).toBe("COMPLETED");

    // A day that announced nothing would pass an `every` over an empty list,
    // which is the classic way this shape of test says nothing at all.
    expect(context.webhookStub.announced.length).toBeGreaterThan(3);

    const loose = context.webhookStub.announced.filter(
      (event) => !event.transactional,
    );

    expect(
      loose.map((event) => event.topic),
      "Eventos enfileirados fora da transação da escrita que os originou",
    ).toEqual([]);
  });

  it("announces the closure inside the write's transaction", async () => {
    const delivery = await seedDelivery();

    await runningRoute([delivery]);

    await context.proof.execute({
      userId: DRIVER_USER_A,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    // The row that carries this event has to commit with the proof itself.
    // Queued after the commit instead, a crash in between erases it, and the
    // customer's ERP keeps a truck out on paper with nothing left to replay
    // from. `WebhookFanOutService` is where that promise is kept; this is
    // where it is checked from the outside.
    expect(closures()[0].transactional).toBe(true);
  });
});
