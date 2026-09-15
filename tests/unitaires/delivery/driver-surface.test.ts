import { describe, expect, it, vi } from "vitest";

import { ListMyDeliveriesUseCase } from "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase";
import { StartDriverRouteUseCase } from "@/modules/delivery/usecases/start-driver-route/start-driver-route-usecase";

import { RegisterDeliveryArrivalUseCase } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-usecase";
import { RegisterDeliveryProofUseCase } from "@/modules/delivery/usecases/register-delivery-proof/register-delivery-proof-usecase";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";

import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import { DeliveryNotFoundError } from "@/modules/delivery/usecases/errors/delivery-errors";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";

const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";

const OTHER_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";
const WEB_USER_ID = "018f0000-0000-7000-8000-0000000000a2";

const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";
const VEHICLE_ID = "018f0000-0000-7000-8000-0000000000c1";
const SUBMISSION = "018f0000-0000-7000-8000-00000000e001";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

// The presigned upload already happened; the stub answers as the bucket
// would for keys the business owns.
const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const outboxStub = {
  publish: async () => {},
} as unknown as OutboxService;

// The occurrence use case wraps write + status + outbox in one database
// transaction; against in-memory repositories the transaction is a plain
// passthrough.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

function makeRepositories() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const occurrenceTypeRepository = new InMemoryOccurrenceTypeRepository();
  const vehicleRepository = new InMemoryVehicleRepository();
  const routeRepository = new InMemoryRouteRepository();

  // One set of stops between the two fakes, as in Postgres. It stays empty in
  // this file — which is the truth for these tests: the driver surface they
  // exercise is the batch path, with no route behind it.
  deliveryRepository.routeStops = routeRepository.stops;

  // The default driver owns a vehicle, which is the ordinary case: the tests
  // that care about the guard take it away instead of adding one.
  vehicleRepository.vehicles.push({
    id: VEHICLE_ID,
    license_plate: "ABC1D23",
    businessId: BUSINESS,
    driverId: DRIVER_ID,
    status: "ACTIVE",
  } as Vehicle);

  userRepository.user.push({
    id: DRIVER_USER_ID,
    name: "João Motorista",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER_ID,
  } as User);

  userRepository.user.push({
    id: WEB_USER_ID,
    name: "Gestora Web",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  return {
    userRepository,
    deliveryRepository,
    occurrenceTypeRepository,
    vehicleRepository,
    routeRepository,
  };
}

async function seedDelivery(
  repository: InMemoryDeliveryRepository,
  overrides: Partial<CreateDeliveryProps> & {
    driverId?: string | null;
    status?: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "CANCELLED";
  } = {},
) {
  const { driverId = DRIVER_ID, status = "PENDING", ...rest } = overrides;

  const delivery = await repository.createDelivery({
    recipient_name: "Cliente A",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
    ...rest,
  } as CreateDeliveryProps);

  delivery.driverId = driverId;
  delivery.status = status;

  return delivery;
}

describe("driver surface: my-deliveries", () => {
  it("returns only the driver's designated and in-transit deliveries", async () => {
    const repos = makeRepositories();

    const designated = await seedDelivery(repos.deliveryRepository);
    const inTransit = await seedDelivery(repos.deliveryRepository, {
      recipient_name: "Cliente B",
      status: "IN_TRANSIT",
    });

    await seedDelivery(repos.deliveryRepository, {
      recipient_name: "Entregue ontem",
      status: "DELIVERED",
    });
    await seedDelivery(repos.deliveryRepository, {
      recipient_name: "De outro motorista",
      driverId: OTHER_DRIVER_ID,
    });

    repos.occurrenceTypeRepository.occurrenceTypes.push(
      {
        id: "type-active",
        name: "Destinatário ausente",
        businessId: BUSINESS,
        is_active: true,
        requires_photo: false,
        blocks_delivery: true,
      } as OccurrenceType,
      {
        id: "type-inactive",
        name: "Tipo desativado",
        businessId: BUSINESS,
        is_active: false,
        requires_photo: false,
        blocks_delivery: false,
      } as OccurrenceType,
    );

    const useCase = new ListMyDeliveriesUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      repos.occurrenceTypeRepository,
    );

    const result = await useCase.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });

    const ids = (result.deliveries as Array<{ id?: string }>).map(
      (entry) => entry.id,
    );

    expect(ids).toHaveLength(2);
    expect(ids).toContain(designated.id);
    expect(ids).toContain(inTransit.id);

    expect(result.occurrenceTypes).toHaveLength(1);
    expect(result.occurrenceTypes[0].id).toBe("type-active");
  });

  it("refuses a user without a linked driver", async () => {
    const repos = makeRepositories();

    const useCase = new ListMyDeliveriesUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      repos.occurrenceTypeRepository,
    );

    await expect(
      useCase.execute({ userId: WEB_USER_ID, businessId: BUSINESS }),
    ).rejects.toMatchObject({ code: "DRIVER_ONLY" });
  });
});

function makeStartRoute(repos: ReturnType<typeof makeRepositories>) {
  return new StartDriverRouteUseCase(
    repos.userRepository,
    repos.deliveryRepository,
    repos.vehicleRepository,
    repos.routeRepository,
    new StartRouteUseCase(
      repos.routeRepository,
      repos.userRepository,
      repos.vehicleRepository,
      notificationStub,
    ),
    notificationStub,
  );
}

describe("driver surface: start route", () => {
  it("moves the driver's pending batch and is idempotent on resend", async () => {
    const repos = makeRepositories();

    await seedDelivery(repos.deliveryRepository);
    await seedDelivery(repos.deliveryRepository, {
      recipient_name: "Cliente B",
    });

    await seedDelivery(repos.deliveryRepository, {
      recipient_name: "Já em rota",
      status: "IN_TRANSIT",
    });
    const foreign = await seedDelivery(repos.deliveryRepository, {
      recipient_name: "De outro motorista",
      driverId: OTHER_DRIVER_ID,
    });

    const useCase = makeStartRoute(repos);

    const first = await useCase.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });

    expect(first.started).toBe(2);
    expect(
      repos.deliveryRepository.deliveries.filter(
        (delivery) =>
          delivery.driverId === DRIVER_ID && delivery.status === "IN_TRANSIT",
      ),
    ).toHaveLength(3);

    // Another driver's load never moves with this one.
    expect(foreign.status).toBe("PENDING");

    const resend = await useCase.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });

    expect(resend.started).toBe(0);
  });

  it("refuses the departure when no vehicle is linked to the driver", async () => {
    const repos = makeRepositories();
    repos.vehicleRepository.vehicles = [];

    const delivery = await seedDelivery(repos.deliveryRepository);
    const useCase = makeStartRoute(repos);

    await expect(
      useCase.execute({ userId: DRIVER_USER_ID, businessId: BUSINESS }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_WITHOUT_VEHICLE",
    });

    // The refusal has to be total: nothing may be left half-dispatched.
    expect(delivery.status).toBe("PENDING");
  });

  it.each(["INACTIVE", "BLOCKED"] as const)(
    "refuses when the driver's only vehicle is %s",
    async (status) => {
      const repos = makeRepositories();
      repos.vehicleRepository.vehicles[0].status = status;

      await seedDelivery(repos.deliveryRepository);

      // This is the guard agreeing with the app: the vehicle screen serves
      // only ACTIVE and IN_ROUTE, so a driver whose single vehicle is out of
      // operation sees "aguardando veículos" and must not be able to leave.
      await expect(
        makeStartRoute(repos).execute({
          userId: DRIVER_USER_ID,
          businessId: BUSINESS,
        }),
      ).rejects.toMatchObject({ code: "DRIVER_WITHOUT_VEHICLE" });
    },
  );

  it("does not accept another driver's vehicle as cover", async () => {
    const repos = makeRepositories();
    repos.vehicleRepository.vehicles[0].driverId = OTHER_DRIVER_ID;

    await seedDelivery(repos.deliveryRepository);

    await expect(
      makeStartRoute(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_WITHOUT_VEHICLE" });
  });

  it("lets an outbox resend succeed after the vehicle link is gone", async () => {
    const repos = makeRepositories();
    await seedDelivery(repos.deliveryRepository);

    const useCase = makeStartRoute(repos);

    const first = await useCase.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });
    expect(first.started).toBe(1);

    // The dispatcher unlinks the vehicle while the driver is already out. A
    // duplicate that the outbox held onto must not turn into a permanent
    // failure over a route that has already left.
    repos.vehicleRepository.vehicles = [];

    const resend = await useCase.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });

    expect(resend.started).toBe(0);
  });

  it("still refuses a real departure that comes after the link is gone", async () => {
    const repos = makeRepositories();
    await seedDelivery(repos.deliveryRepository);
    repos.vehicleRepository.vehicles = [];

    // Nothing has left yet, so this IS a departure and the guard applies.
    await expect(
      makeStartRoute(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_WITHOUT_VEHICLE" });
  });

  it("starts normally while the vehicle is already IN_ROUTE", async () => {
    const repos = makeRepositories();
    repos.vehicleRepository.vehicles[0].status = "IN_ROUTE";

    await seedDelivery(repos.deliveryRepository);

    // Tomorrow's load is dispatched while today's route is still out, so a
    // vehicle already on the street is not a reason to refuse.
    const result = await makeStartRoute(repos).execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
    });

    expect(result.started).toBe(1);
  });
});

describe("driver surface: arrival", () => {
  function makeUseCase(repos: ReturnType<typeof makeRepositories>) {
    return new RegisterDeliveryArrivalUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      repos.routeRepository,
      notificationStub,
    );
  }

  it("records the event once, no matter how often the outbox resends", async () => {
    const repos = makeRepositories();
    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    const useCase = makeUseCase(repos);
    const request = {
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      client_submission_id: SUBMISSION,
      latitude: -22.5,
      longitude: -43.2,
    };

    await useCase.execute(request);
    await useCase.execute(request);

    expect(repos.deliveryRepository.events).toHaveLength(1);
    expect(repos.deliveryRepository.events[0].type).toBe("ARRIVAL");
    expect(repos.deliveryRepository.events[0].latitude).toBe(-22.5);
  });

  it("requires the delivery to be in transit", async () => {
    const repos = makeRepositories();
    const delivery = await seedDelivery(repos.deliveryRepository);

    await expect(
      makeUseCase(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId: delivery.id!,
        client_submission_id: SUBMISSION,
        latitude: 0,
        longitude: 0,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_IN_TRANSIT" });
  });

  it("hides another driver's delivery", async () => {
    const repos = makeRepositories();
    const delivery = await seedDelivery(repos.deliveryRepository, {
      driverId: OTHER_DRIVER_ID,
      status: "IN_TRANSIT",
    });

    await expect(
      makeUseCase(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId: delivery.id!,
        client_submission_id: SUBMISSION,
        latitude: 0,
        longitude: 0,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });
});

describe("driver surface: proof", () => {
  function makeUseCase(repos: ReturnType<typeof makeRepositories>) {
    return new RegisterDeliveryProofUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      repos.routeRepository,
      notificationStub,
      outboxStub,
      uploadStub,
    );
  }

  it("stamps DELIVERED with the proof event, idempotently", async () => {
    const repos = makeRepositories();
    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    const useCase = makeUseCase(repos);
    const request = {
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      client_submission_id: SUBMISSION,
      photo: `deliveryPhotos/${BUSINESS}/canhoto.webp`,
      signature: `deliveryPhotos/${BUSINESS}/assinatura.png`,
      received_by: "Maria Recebedora",
    };

    await useCase.execute(request);

    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.delivered_at).toBeInstanceOf(Date);
    expect(delivery.received_by).toBe("Maria Recebedora");

    const [event] = repos.deliveryRepository.events;
    expect(event.type).toBe("PROOF");
    expect(event.photo).toBe(`deliveryPhotos/${BUSINESS}/canhoto.webp`);
    expect(event.signature).toBe(
      `deliveryPhotos/${BUSINESS}/assinatura.png`,
    );

    // The outbox resend after a dead network: no second event, no error,
    // and the delivery stays proven.
    await useCase.execute(request);

    expect(repos.deliveryRepository.events).toHaveLength(1);
    expect(delivery.status).toBe("DELIVERED");
  });

  it("refuses proving a delivery that is not in transit", async () => {
    const repos = makeRepositories();
    const delivery = await seedDelivery(repos.deliveryRepository);

    await expect(
      makeUseCase(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId: delivery.id!,
        client_submission_id: SUBMISSION,
        photo: `deliveryPhotos/${BUSINESS}/canhoto.webp`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });

    expect(repos.deliveryRepository.events).toHaveLength(0);
  });
});

describe("driver surface: occurrence photo rules", () => {
  function makeUseCase(
    repos: ReturnType<typeof makeRepositories>,
    outbox: OutboxService = outboxStub,
  ) {
    return new ReportDeliveryOccurrenceUseCase(
      repos.userRepository,
      repos.occurrenceTypeRepository,
      repos.deliveryRepository,
      repos.routeRepository,
      notificationStub,
      uploadStub,
      outbox,
    );
  }

  function seedPhotoRequiredType(
    repos: ReturnType<typeof makeRepositories>,
  ): void {
    repos.occurrenceTypeRepository.occurrenceTypes.push({
      id: "type-photo",
      name: "Avaria na carga",
      businessId: BUSINESS,
      is_active: true,
      requires_photo: true,
      blocks_delivery: false,
    } as OccurrenceType);
  }

  it("demands the photo from a driver on a photo-required type", async () => {
    const repos = makeRepositories();
    seedPhotoRequiredType(repos);

    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    await expect(
      makeUseCase(repos).execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId: delivery.id!,
        occurrenceTypeId: "type-photo",
      }),
    ).rejects.toMatchObject({ code: "OCCURRENCE_PHOTO_REQUIRED" });

    await makeUseCase(repos).execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-photo",
      photos: [`deliveryPhotos/${BUSINESS}/avaria.webp`],
    });

    expect(repos.deliveryRepository.occurrences).toHaveLength(1);
    expect(repos.deliveryRepository.occurrences[0].photos).toEqual([
      `deliveryPhotos/${BUSINESS}/avaria.webp`,
    ]);
  });

  it("does not demand the photo from a web manager", async () => {
    const repos = makeRepositories();
    seedPhotoRequiredType(repos);

    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    // Recording an administrative fact: the manager has no camera in hand.
    await makeUseCase(repos).execute({
      userId: WEB_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-photo",
    });

    expect(repos.deliveryRepository.occurrences).toHaveLength(1);
  });

  it("collapses an outbox resend into a single occurrence", async () => {
    const repos = makeRepositories();
    seedPhotoRequiredType(repos);

    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    const request = {
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-photo",
      photos: [`deliveryPhotos/${BUSINESS}/avaria.webp`],
      client_submission_id: SUBMISSION,
    };

    await makeUseCase(repos).execute(request);
    await makeUseCase(repos).execute(request);

    expect(repos.deliveryRepository.occurrences).toHaveLength(1);
  });

  it("rings the manager's bell only for a blocking type", async () => {
    const repos = makeRepositories();
    seedPhotoRequiredType(repos);

    repos.occurrenceTypeRepository.occurrenceTypes.push({
      id: "type-blocking",
      name: "Recusa da mercadoria",
      businessId: BUSINESS,
      is_active: true,
      requires_photo: false,
      blocks_delivery: true,
    } as OccurrenceType);

    const delivery = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });

    const publishedTopics: string[] = [];

    const recorder = {
      publish: async (_tx: unknown, event: { topic: string }) => {
        publishedTopics.push(event.topic);
      },
    } as unknown as OutboxService;

    // Informational type: trail only, no bell.
    await makeUseCase(repos, recorder).execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-photo",
      photos: [`deliveryPhotos/${BUSINESS}/foto.webp`],
    });

    expect(publishedTopics).toHaveLength(0);

    // Blocking type: the delivery fails and the managers hear about it.
    await makeUseCase(repos, recorder).execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-blocking",
    });

    expect(publishedTopics).toEqual(["delivery-occurrence.reported"]);

    // The in-memory repository replaces the row on a status patch, so the
    // assertion reads the array, not the stale reference.
    expect(
      repos.deliveryRepository.deliveries.find(
        (entry) => entry.id === delivery.id,
      )?.status,
    ).toBe("FAILED");
  });
});
