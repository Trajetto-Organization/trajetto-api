import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyProofUseCase,
  businessWithoutAI as reportsWithoutAI,
} from "../../support/delivery-proof-usecases";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";

import { RegisterDeliveryArrivalUseCase } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";
import { StartDriverRouteUseCase } from "@/modules/delivery/usecases/start-driver-route/start-driver-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { buildDeliveryTimeline } from "@/shared/delivery/delivery-timeline";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * What the driver did offline, stamped with when they did it (MOB-08).
 *
 * The proof was taken at 10:05 in a dead zone and reached the server at 13:40.
 * The customer was told "entregue às 13:40", the stop closed at 13:40 and the
 * SLA counted three and a half hours of delay that never happened. The app now
 * sends the instant of the tap; the controller turns it into `occurredAt`
 * (see resolveOccurredAt) and these use cases must stamp THAT — while the
 * rows' created_at stays the instant of receipt, which is what every
 * incremental reader pages by.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const A = "018f0000-0000-7000-8000-00000000000a";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const BLOCKING_TYPE = "018f0000-0000-7000-8000-0000000000c1";
const INFO_TYPE = "018f0000-0000-7000-8000-0000000000c2";

const HOUR = 60 * 60 * 1000;

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

const uploadService = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const businessWithoutAI = {
  findBusinessById: async () => ({ ai_analysis_limit: 0 }),
} as unknown as IBusinessRepository;

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

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();
  const occurrenceTypeRepository = new InMemoryOccurrenceTypeRepository();

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
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: A,
    driverId: DRIVER,
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
      name: "Portaria demorou",
      businessId: A,
      is_active: true,
      blocks_delivery: false,
      requires_photo: false,
    } as OccurrenceType,
  );

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
    deliveryRepository,
    routeRepository,
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
    legacyStart: new StartDriverRouteUseCase(
      userRepository,
      deliveryRepository,
      vehicleRepository,
      notificationService,
    ),
    arrival: new RegisterDeliveryArrivalUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      webhooks.asService(),
    ),
    proof: legacyProofUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      outbox,
      new InMemoryProofAuditRepository(),
      businessWithoutAI,
      uploadService,
      webhooks.asService(),
    ),
    occurrence: new ReportDeliveryOccurrenceUseCase(
      userRepository,
      occurrenceTypeRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      uploadService,
      outbox,
      webhooks.asService(),
      new InMemoryOccurrenceAuthorizationRepository(
        deliveryRepository,
        occurrenceTypeRepository,
        userRepository,
      ),
      new InMemoryProofAuditRepository(),
      reportsWithoutAI,
    ),
  };
}

let context: ReturnType<typeof makeContext>;
let counter = 0;

beforeEach(() => {
  context = makeContext();
});

function submission(): string {
  counter += 1;

  return `018f0000-0000-7000-8000-0000000f${String(counter).padStart(4, "0")}`;
}

async function seedDelivery(): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    recipient_name: "Cliente",
    // Somebody to tell, so the customer notice is published and its
    // "entregue às" can be checked.
    recipient_telephone: "11999999999",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created.id!;
}

async function releasedRoute(deliveryIds: string[]): Promise<string> {
  const route = await context.create.execute({
    userId: DISPATCHER,
    businessId: A,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    scheduled_date: new Date(),
    deliveryIds,
  });

  await context.release.execute({
    userId: DISPATCHER,
    businessId: A,
    routeId: route.id,
  });

  return route.id;
}

async function runningRoute(deliveryIds: string[]): Promise<string> {
  const routeId = await releasedRoute(deliveryIds);

  await context.start.execute({ userId: DRIVER_USER, businessId: A, routeId });

  return routeId;
}

const stopOf = (deliveryId: string) =>
  context.routeRepository.stops.find((stop) => stop.deliveryId === deliveryId)!;

const deliveryOf = (deliveryId: string) =>
  context.deliveryRepository.deliveries.find(
    (entry) => entry.id === deliveryId,
  )!;

const routeOf = (routeId: string) =>
  context.routeRepository.routes.find((route) => route.id === routeId)!;

describe("a proof sent hours after it was taken", () => {
  it("is delivered at the moment of the proof, not of the upload", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const provenAt = new Date(Date.now() - 3 * HOUR);

    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
      occurredAt: provenAt,
    });

    expect(deliveryOf(delivery).delivered_at).toEqual(provenAt);

    const proof = context.deliveryRepository.events.find(
      (event) => event.type === "PROOF",
    );
    expect(proof?.occurred_at).toEqual(provenAt);

    // The stop, and through it the route's punctuality.
    expect(stopOf(delivery).completed_at).toEqual(provenAt);

    // What the person waiting is told.
    const notice = context.published.find(
      (event) => event.topic === "delivery.delivered",
    );
    expect(notice?.payload.deliveredAt).toEqual(provenAt);
  });

  it("keeps the server's clock when the app did not say", async () => {
    // Every build in the field before this one.
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const before = Date.now();

    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    const deliveredAt = deliveryOf(delivery).delivered_at as Date;
    expect(deliveredAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("an arrival sent hours after it happened", () => {
  it("records the arrival at the moment of the tap", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const arrivedAt = new Date(Date.now() - 2 * HOUR);

    await context.arrival.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      latitude: -23.55,
      longitude: -46.63,
      occurredAt: arrivedAt,
    });

    const arrival = context.deliveryRepository.events.find(
      (event) => event.type === "ARRIVAL",
    );
    expect(arrival?.occurred_at).toEqual(arrivedAt);
    expect(stopOf(delivery).arrived_at).toEqual(arrivedAt);
  });
});

describe("a blocking occurrence sent hours after it happened", () => {
  it("closes the stop at the moment of the occurrence", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const reportedAt = new Date(Date.now() - HOUR);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
      occurredAt: reportedAt,
    });

    expect(context.deliveryRepository.occurrences[0].occurred_at).toEqual(
      reportedAt,
    );
    expect(stopOf(delivery).status).toBe("FAILED");
    expect(stopOf(delivery).completed_at).toEqual(reportedAt);
  });
});

describe("a route whose last stop resolves offline", () => {
  it("ends when the work did, not when the upload came in", async () => {
    const proven = await seedDelivery();
    const failed = await seedDelivery();
    const routeId = await runningRoute([proven, failed]);

    // It left before either fact.
    routeOf(routeId).started_at = new Date(Date.now() - 5 * HOUR);

    const reportedAt = new Date(Date.now() - 2 * HOUR);
    const provenAt = new Date(Date.now() - 3 * HOUR);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: failed,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
      occurredAt: reportedAt,
    });

    // The older fact arrives last and closes the route: the route still ends
    // at the later one.
    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: proven,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
      occurredAt: provenAt,
    });

    expect(routeOf(routeId).status).toBe("COMPLETED");
    expect(routeOf(routeId).completed_at).toEqual(reportedAt);
  });
});

describe("the webhooks of a fact sent late", () => {
  const announced = (topic: string) =>
    context.webhooks.announced.find((event) => event.topic === topic)?.payload;

  it("carry the moment of the proof, apart from the fan-out's", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const provenAt = new Date(Date.now() - 3 * HOUR);

    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
      occurredAt: provenAt,
    });

    expect(announced("proof.registered")?.occurred_at).toBe(
      provenAt.toISOString(),
    );
    expect(announced("delivery.delivered")?.occurred_at).toBe(
      provenAt.toISOString(),
    );
  });

  it("carry the moment of the occurrence", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const reportedAt = new Date(Date.now() - HOUR);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
      occurredAt: reportedAt,
    });

    expect(announced("occurrence.reported")?.occurred_at).toBe(
      reportedAt.toISOString(),
    );
  });

  it("carry the receipt, the fact's time as recorded, for a build that sends none", async () => {
    // With no tap, two separate reads of the clock stand behind this
    // equality: the use case's fallback (the webhook) and the repository's
    // delivered_at stamp. A millisecond ticking between them would fail the
    // assertion at random, so the clock is held still.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T13:40:00.000Z"));

    try {
      const delivery = await seedDelivery();
      await runningRoute([delivery]);

      await context.proof.execute({
        userId: DRIVER_USER,
        businessId: A,
        deliveryId: delivery,
        client_submission_id: submission(),
        photo: "canhoto.jpg",
      });

      // The same instant the delivery was stamped delivered at.
      const deliveredAt = (
        deliveryOf(delivery).delivered_at as Date
      ).toISOString();

      expect(deliveredAt).toBe("2026-09-24T13:40:00.000Z");
      expect(announced("proof.registered")?.occurred_at).toBe(deliveredAt);
      expect(announced("delivery.delivered")?.occurred_at).toBe(deliveredAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the customer's systems hear about a driver's outcome", () => {
  /**
   * The catalogue says the document events carry "o status da entrega
   * depois do evento", and delivery.failed is "a entrega terminou sem
   * sucesso". The proof and the occurrence read the status BEFORE the event
   * (IN_TRANSIT), and a blocking occurrence — the way a driver fails a
   * delivery in the field — announced no delivery.failed and told the waiting
   * customer nothing, while the same outcome set from the panel did both.
   */
  const announced = (topic: string) =>
    context.webhooks.announced.filter((event) => event.topic === topic);

  it("says DELIVERED on proof.registered, the status after the proof", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
    });

    expect(announced("proof.registered")[0]?.payload.status).toBe("DELIVERED");
  });

  it("says FAILED on a blocking occurrence, and announces delivery.failed at the fact's time", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const reportedAt = new Date(Date.now() - HOUR);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
      occurredAt: reportedAt,
    });

    expect(announced("occurrence.reported")[0]?.payload.status).toBe("FAILED");

    const failed = announced("delivery.failed");

    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      delivery_id: delivery,
      status: "FAILED",
      occurred_at: reportedAt.toISOString(),
    });
  });

  it("tells the waiting customer, as the panel does", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: BLOCKING_TYPE,
      client_submission_id: submission(),
    });

    expect(context.published.map((event) => event.topic)).toContain(
      "delivery.failed",
    );
  });

  it("announces no failure for an occurrence that does not block", async () => {
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    await context.occurrence.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      occurrenceTypeId: INFO_TYPE,
      client_submission_id: submission(),
    });

    expect(announced("occurrence.reported")[0]?.payload.status).toBe(
      "IN_TRANSIT",
    );
    expect(announced("delivery.failed")).toHaveLength(0);
    expect(context.published.map((event) => event.topic)).not.toContain(
      "delivery.failed",
    );
  });

  it("carries when the route started and ended, the facts' times", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    routeOf(routeId).created_at = new Date(Date.now() - 3 * HOUR);

    const departedAt = new Date(Date.now() - 2 * HOUR);
    const provenAt = new Date(Date.now() - HOUR);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: A,
      routeId,
      occurredAt: departedAt,
    });

    await context.proof.execute({
      userId: DRIVER_USER,
      businessId: A,
      deliveryId: delivery,
      client_submission_id: submission(),
      photo: "canhoto.jpg",
      occurredAt: provenAt,
    });

    expect(announced("route.started")[0]?.payload).toMatchObject({
      started_at: departedAt.toISOString(),
      occurred_at: departedAt.toISOString(),
    });
    expect(announced("route.completed")[0]?.payload).toMatchObject({
      completed_at: provenAt.toISOString(),
      occurred_at: provenAt.toISOString(),
    });
  });
});

describe("a departure sent after it happened", () => {
  it("starts the route at the moment of the tap", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    // The route exists and was released before the tap.
    routeOf(routeId).created_at = new Date(Date.now() - 2 * HOUR);

    const departedAt = new Date(Date.now() - 40 * 60 * 1000);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: A,
      routeId,
      occurredAt: departedAt,
    });

    expect(routeOf(routeId).status).toBe("IN_PROGRESS");
    expect(routeOf(routeId).started_at).toEqual(departedAt);
  });
});

describe("a legacy departure replayed after a new route was released", () => {
  it("does not start a route that did not exist when the driver tapped", async () => {
    // Tapped yesterday through the old endpoint (no route in the app's
    // cache), queued, and sent today — after the dispatcher released today's
    // route. Starting it would announce "saiu para entrega" to every customer
    // of a truck that is still in the yard.
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER,
      businessId: A,
      occurredAt: new Date(Date.now() - 20 * HOUR),
    });

    expect(result).toEqual({ started: 0 });
    expect(routeOf(routeId).status).toBe("RELEASED");
    expect(deliveryOf(delivery).status).toBe("PENDING");
  });

  it("does not start it even when the tap came after the route existed", async () => {
    // IDEMP-17: the legacy endpoint never starts a route. The app calls it
    // only when it shows no route, so the route it would find is one the tap
    // never saw; that route leaves through its own endpoint.
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER,
      businessId: A,
      occurredAt: new Date(),
    });

    expect(result.started).toBe(0);
    expect(routeOf(routeId).status).toBe("RELEASED");
  });
});

describe("a legacy departure of loose deliveries, replayed late", () => {
  /** A delivery with no route, designated to the driver, created `agoMs` ago. */
  async function looseDelivery(agoMs: number): Promise<string> {
    const id = await seedDelivery();

    deliveryOf(id).driverId = DRIVER;
    deliveryOf(id).created_at = new Date(Date.now() - agoMs);

    return id;
  }

  it("moves nothing when the tap is older than the offline horizon", async () => {
    // A week-old "start my day" is not a command about today. The loose
    // deliveries designated since would leave with the truck in the yard.
    const loose = await looseDelivery(HOUR);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER,
      businessId: A,
      occurredAt: null,
      staleTap: true,
    });

    expect(result).toEqual({ started: 0 });
    expect(deliveryOf(loose).status).toBe("PENDING");
  });

  it("moves only what existed when the driver tapped", async () => {
    const seen = await looseDelivery(3 * HOUR);
    const createdAfter = await looseDelivery(30 * 60 * 1000);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER,
      businessId: A,
      occurredAt: new Date(Date.now() - 2 * HOUR),
    });

    expect(result).toEqual({ started: 1 });
    expect(deliveryOf(seen).status).toBe("IN_TRANSIT");

    // Created after the tap: the phone never showed it, and it is still in
    // the warehouse. The driver's next "Iniciar rota" takes it.
    expect(deliveryOf(createdAfter).status).toBe("PENDING");
  });

  it("moves every loose delivery for a build that sends no time", async () => {
    const older = await looseDelivery(3 * HOUR);
    const newer = await looseDelivery(60 * 1000);

    const result = await context.legacyStart.execute({
      userId: DRIVER_USER,
      businessId: A,
    });

    expect(result).toEqual({ started: 2 });
    expect(deliveryOf(older).status).toBe("IN_TRANSIT");
    expect(deliveryOf(newer).status).toBe("IN_TRANSIT");
  });
});

describe("the support timeline", () => {
  it("places an offline event at the moment it happened", () => {
    const receivedAt = new Date("2026-09-24T13:40:00.000Z");
    const provenAt = new Date("2026-09-24T10:05:00.000Z");
    const noteAt = new Date("2026-09-24T12:00:00.000Z");

    const timeline = buildDeliveryTimeline({
      events: [
        {
          id: "018f0000-0000-7000-8000-000000000002",
          type: "PROOF",
          created_at: receivedAt,
          occurred_at: provenAt,
        },
        {
          id: "018f0000-0000-7000-8000-000000000001",
          type: "NOTE",
          created_at: noteAt,
          note: "Cliente ligou",
        },
      ],
    });

    // The proof happened before the note, although it arrived after it.
    expect(timeline.map((entry) => entry.kind)).toEqual(["NOTE", "PROOF"]);
    expect(timeline[1].at).toEqual(provenAt);
  });
});
