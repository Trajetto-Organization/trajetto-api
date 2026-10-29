import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacyProofUseCase } from "../../support/delivery-proof-usecases";

import { CreateRouteUseCase } from "@/modules/route/usecases/create-route/create-route-usecase";
import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * The same submission, twice, at the same time.
 *
 * The app's HTTP client gives up after 20 s; the server may still be writing.
 * The outbox then resends at once, and the second request overtakes the
 * idempotency pre-check of the first: both read "not recorded yet", both
 * validate, and only the write itself notices. The loser used to come back as
 * a 409 — "the delivery changed while you were working on it" / "the route
 * changed" — which the app reads as the API refusing on the merits: the item
 * lands on the pending screen as `failed`, carrying a message that is false,
 * for a proof or a departure that was recorded.
 *
 * A barrier holds both requests at the pre-read until both have made it, so
 * the race is forced rather than left to scheduling luck.
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
const OTHER_VEHICLE = "018f0000-0000-7000-8000-0000000000e2";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const SUBMISSION = "018f0000-0000-7000-8000-0000000c0001";

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

const uploadService = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const outboxStub = {
  publish: async () => undefined,
} as unknown as OutboxService;

const businessWithoutAI = {
  findBusinessById: async () => ({ ai_analysis_limit: 0 }),
} as unknown as IBusinessRepository;

/**
 * Holds the first `parties` calls until all of them have arrived, then lets
 * every later call straight through — the re-read a fix makes after losing
 * the race must not wait on anybody.
 */
function barrier<Args extends unknown[], R>(
  parties: number,
  original: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return async (...args: Args) => {
    if (arrived < parties) {
      arrived += 1;
      const result = await original(...args);
      if (arrived === parties) open();
      await gate;
      return result;
    }

    return original(...args);
  };
}

function makeContext() {
  const webhooks = new InMemoryWebhookFanOutService();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries,
  );

  deliveryRepository.routeStops = routeRepository.stops;

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

  vehicleRepository.vehicles.push(
    {
      id: VEHICLE,
      license_plate: "AAA1A11",
      status: "ACTIVE",
      businessId: A,
      driverId: DRIVER,
    } as Vehicle,
    {
      id: OTHER_VEHICLE,
      license_plate: "BBB2B22",
      status: "ACTIVE",
      businessId: A,
    } as Vehicle,
  );

  return {
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
      outboxStub,
      webhooks.asService(),
    ),
    start: new StartRouteUseCase(
      routeRepository,
      userRepository,
      vehicleRepository,
      notificationService,
      outboxStub,
      webhooks.asService(),
    ),
    proof: legacyProofUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationService,
      outboxStub,
      new InMemoryProofAuditRepository(),
      businessWithoutAI,
      uploadService,
      webhooks.asService(),
    ),
  };
}

let context: ReturnType<typeof makeContext>;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(): Promise<string> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: A,
    shipperId: SHIPPER,
    recipient_name: "Cliente",
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

describe("a proof resent while the first attempt is still being written", () => {
  it("answers the resend as success, not as a status conflict", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: A,
      routeId,
    });

    const repository = context.deliveryRepository;
    repository.findEventBySubmissionId = barrier(
      2,
      repository.findEventBySubmissionId.bind(repository),
    );

    // Postgres hands each request its own snapshot of the row; the fake hands
    // out the live object, so the loser would read the winner's DELIVERED as
    // its own precondition and the race would never reach the write guard.
    const readRow = repository.findDeliveryById.bind(repository);
    repository.findDeliveryById = async (id) => {
      const row = await readRow(id);
      return row ? { ...row } : null;
    };

    const send = () =>
      context.proof.execute({
        userId: DRIVER_USER,
        businessId: A,
        deliveryId: delivery,
        client_submission_id: SUBMISSION,
        photo: "canhoto.jpg",
      });

    const [first, resend] = await Promise.allSettled([send(), send()]);

    expect(first.status).toBe("fulfilled");
    // Decision 14.3: the proof answers where the submission stands.
    expect(resend).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ replayed: true, category: "DELIVERED" }),
    });

    // Recorded once: the resend is answered, not repeated.
    expect(
      repository.events.filter(
        (event) => event.client_submission_id === SUBMISSION,
      ),
    ).toHaveLength(1);
    expect(
      repository.deliveries.find((entry) => entry.id === delivery)?.status,
    ).toBe("DELIVERED");

    // One webhook per topic: the loser must not announce the proof again.
    expect(context.webhooks.forTopic("proof.registered")).toHaveLength(1);
  });

  it("still refuses with 409 when the conflict was somebody else's write", async () => {
    // The other half: without it, a use case that swallowed every conflict
    // would pass the test above. A dispatcher cancelling while the driver
    // uploads is a real refusal, and the driver has to be told.
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    await context.start.execute({
      userId: DRIVER_USER,
      businessId: A,
      routeId,
    });

    const repository = context.deliveryRepository;
    const original = repository.registerDeliveryProof.bind(repository);

    repository.registerDeliveryProof = async (...args) => {
      const row = repository.deliveries.find((entry) => entry.id === delivery)!;
      row.status = "CANCELLED";
      return original(...args);
    };

    await expect(
      context.proof.execute({
        userId: DRIVER_USER,
        businessId: A,
        deliveryId: delivery,
        client_submission_id: SUBMISSION,
        photo: "canhoto.jpg",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_STATUS_CONFLICT",
    });
  });
});

describe("a departure resent while the first attempt is still being written", () => {
  it("answers the resend with the running route, not ROUTE_STATUS_CONFLICT", async () => {
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    const repository = context.routeRepository;
    repository.findRouteById = barrier(
      2,
      repository.findRouteById.bind(repository),
    );

    const depart = () =>
      context.start.execute({ userId: DRIVER_USER, businessId: A, routeId });

    const [first, resend] = await Promise.allSettled([depart(), depart()]);

    expect(first.status).toBe("fulfilled");
    // The rejection itself on failure, so the red run shows which refusal.
    expect(resend.status === "rejected" ? resend.reason : null).toBeNull();
    expect(
      (resend as PromiseFulfilledResult<{ id: string; status: string }>).value,
    ).toMatchObject({ id: routeId, status: "IN_PROGRESS" });

    expect(context.webhooks.forTopic("route.started")).toHaveLength(1);
  });

  it("still refuses when the resend names a different truck", async () => {
    // The winner left with VEHICLE; a request asking for OTHER_VEHICLE is a
    // swap after the route was already on the street — a real conflict.
    const delivery = await seedDelivery();
    const routeId = await releasedRoute([delivery]);

    const repository = context.routeRepository;
    repository.findRouteById = barrier(
      2,
      repository.findRouteById.bind(repository),
    );

    const [first, swap] = await Promise.allSettled([
      context.start.execute({ userId: DRIVER_USER, businessId: A, routeId }),
      context.start.execute({
        userId: DRIVER_USER,
        businessId: A,
        routeId,
        vehicleId: OTHER_VEHICLE,
      }),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(swap.status).toBe("rejected");
    expect((swap as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
    });
  });
});
