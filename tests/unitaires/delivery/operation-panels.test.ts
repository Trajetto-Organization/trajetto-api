import { describe, expect, it } from "vitest";

import { ListOccurrencesUseCase } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-usecase";
import { OperationSummaryUseCase } from "@/modules/delivery/usecases/operation-summary/operation-summary-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";

import {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateKey,
  dateOnlyFromKey,
} from "@/shared/time/business-day";

import type { UploadService } from "@/shared/services/upload-service";
import type { User } from "@/modules/user/dtos/user-dto";

import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const MANAGER_ID = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000a1";

const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";

const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

const TYPE_BLOCKING = "018f0000-0000-7000-8000-0000000000t1";
const TYPE_INFO = "018f0000-0000-7000-8000-0000000000t2";

// The panel signs photo URLs on read; the stub answers like local storage.
const uploadStub = {
  getFileUrl: async (key: string) => `http://storage.local/${key}`,
} as unknown as UploadService;

function makeRepositories() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  userRepository.user.push({
    id: MANAGER_ID,
    name: "Gestora Web",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  userRepository.user.push({
    id: DRIVER_USER_ID,
    name: "João Motorista",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER_ID,
  } as User);

  deliveryRepository.seedOccurrenceType({
    id: TYPE_BLOCKING,
    businessId: BUSINESS,
    name: "Recusa",
    blocks_delivery: true,
  });
  deliveryRepository.seedOccurrenceType({
    id: TYPE_INFO,
    businessId: BUSINESS,
    name: "Destinatário ausente",
    blocks_delivery: false,
  });

  deliveryRepository.driverDirectory.set(DRIVER_ID, {
    name: "João Motorista",
    cnh: "111",
  });
  deliveryRepository.driverDirectory.set(OTHER_DRIVER_ID, {
    name: "Maria Motorista",
    cnh: "222",
  });

  return { userRepository, deliveryRepository };
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

describe("occurrence feed", () => {
  async function seedFeed(repos: ReturnType<typeof makeRepositories>) {
    const mine = await seedDelivery(repos.deliveryRepository, {
      status: "IN_TRANSIT",
    });
    const other = await seedDelivery(repos.deliveryRepository, {
      recipient_name: "Cliente de Maria",
      driverId: OTHER_DRIVER_ID,
      status: "IN_TRANSIT",
    });
    const foreign = await seedDelivery(repos.deliveryRepository, {
      recipient_name: "De outra empresa",
      businessId: OTHER_BUSINESS,
    });

    await repos.deliveryRepository.createOccurrence({
      deliveryId: mine.id!,
      occurrenceTypeId: TYPE_BLOCKING,
      reportedById: DRIVER_USER_ID,
      photos: [`deliveryPhotos/${BUSINESS}/a.webp`],
    });
    await repos.deliveryRepository.createOccurrence({
      deliveryId: other.id!,
      occurrenceTypeId: TYPE_INFO,
      reportedById: DRIVER_USER_ID,
    });
    await repos.deliveryRepository.createOccurrence({
      deliveryId: foreign.id!,
      occurrenceTypeId: TYPE_INFO,
      reportedById: DRIVER_USER_ID,
    });

    return { mine, other };
  }

  function makeUseCase(repos: ReturnType<typeof makeRepositories>) {
    return new ListOccurrencesUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      uploadStub,
    );
  }

  it("scopes to the business and signs photo URLs", async () => {
    const repos = makeRepositories();
    await seedFeed(repos);

    const result = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
    });

    // The foreign company's occurrence never crosses the tenant line.
    expect(result.total).toBe(2);

    const withPhoto = (
      result.data as Array<{ photos: string[] }>
    ).find((entry) => entry.photos.length > 0);

    expect(withPhoto?.photos[0]).toBe(
      `http://storage.local/deliveryPhotos/${BUSINESS}/a.webp`,
    );
  });

  it("filters by blocking type", async () => {
    const repos = makeRepositories();
    const { mine } = await seedFeed(repos);

    const result = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
      severity: ["blocking"],
    });

    expect(result.total).toBe(1);
    expect(
      (result.data as Array<{ deliveryId: string }>)[0].deliveryId,
    ).toBe(mine.id);
  });

  it("finds a row by the ids the row menu copies", async () => {
    const repos = makeRepositories();
    const { mine } = await seedFeed(repos);

    const [firstOccurrence] = repos.deliveryRepository.occurrences;

    // Copiar ID → paste in the search: the occurrence comes back.
    const byOccurrenceId = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
      search: firstOccurrence.id,
    });

    expect(byOccurrenceId.total).toBe(1);

    // Copiar ID da Entrega → every occurrence of that delivery.
    const byDeliveryId = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
      search: mine.id!,
    });

    expect(byDeliveryId.total).toBe(1);
    expect(
      (byDeliveryId.data as Array<{ deliveryId: string }>)[0].deliveryId,
    ).toBe(mine.id);
  });

  // Defence in depth: the route refuses driver tokens with 403
  // (tests/E2E/occurrence-feed-http.test.ts); should a caller ever let one
  // through, the use case still narrows the feed to their deliveries.
  it("narrows a driver reaching the use case to their own deliveries", async () => {
    const repos = makeRepositories();
    const { mine } = await seedFeed(repos);

    const result = await makeUseCase(repos).execute({
      userId: DRIVER_USER_ID,
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(1);
    expect(
      (result.data as Array<{ deliveryId: string }>)[0].deliveryId,
    ).toBe(mine.id);
  });
});

describe("operation summary", () => {
  /**
   * The tower's twin over the delivery twin's rows: the day's documents are
   * the tower's (decision 7.1), the backlog and reports the delivery twin's.
   * No business row: the default zone. The company's own zone is covered in
   * operation-summary-day.test.ts.
   */
  function towerOf(
    repos: ReturnType<typeof makeRepositories>,
    todaysRoute: string[] = [],
  ): InMemoryOperationDayRepository {
    const tower = new InMemoryOperationDayRepository();

    tower.rows.drivers.push(
      { id: DRIVER_ID, businessId: BUSINESS, name: "João Motorista", cnh: "111" },
      { id: OTHER_DRIVER_ID, businessId: BUSINESS, name: "Maria Motorista", cnh: "222" },
    );

    for (const delivery of repos.deliveryRepository.deliveries) {
      tower.rows.deliveries.push({
        id: delivery.id!,
        businessId: delivery.businessId,
        status: delivery.status as never,
        driverId: delivery.driverId ?? null,
        recipient_name: delivery.recipient_name,
        city: delivery.city,
        delivered_at: delivery.delivered_at ? new Date(delivery.delivered_at) : null,
        updated_at: new Date(delivery.updated_at ?? Date.now()),
      });
    }

    if (todaysRoute.length > 0) {
      tower.rows.routes.push({
        id: "route-today",
        businessId: BUSINESS,
        code: 1,
        name: null,
        destination: null,
        status: "RELEASED",
        scheduled_date: dateOnlyFromKey(
          businessDateKey(new Date(), DEFAULT_BUSINESS_TIMEZONE),
        ),
        planned_departure_at: null,
        started_at: null,
        completed_at: null,
        updated_at: new Date(),
        driverId: DRIVER_ID,
        vehicleId: null,
      });

      todaysRoute.forEach((deliveryId, index) =>
        tower.rows.stops.push({
          id: `stop-${index}`,
          routeId: "route-today",
          deliveryId,
          sequence: (index + 1) * 10,
          status: "PENDING",
          on_the_way_at: null,
          arrived_at: null,
          completed_at: null,
          updated_at: new Date(),
        }),
      );
    }

    return tower;
  }

  function makeUseCase(
    repos: ReturnType<typeof makeRepositories>,
    tower = towerOf(repos),
  ) {
    return new OperationSummaryUseCase(
      repos.userRepository,
      repos.deliveryRepository,
      tower,
    );
  }

  it("counts the day per driver, busiest first", async () => {
    const repos = makeRepositories();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // João: two in route, one designated on today's route, one failed today.
    await seedDelivery(repos.deliveryRepository, { status: "IN_TRANSIT" });
    await seedDelivery(repos.deliveryRepository, { status: "IN_TRANSIT" });
    const designated = await seedDelivery(repos.deliveryRepository, {
      status: "PENDING",
    });
    const failed = await seedDelivery(repos.deliveryRepository, {
      status: "FAILED",
    });
    failed.updated_at = new Date();

    // Maria: delivered one today and one yesterday.
    const deliveredToday = await seedDelivery(repos.deliveryRepository, {
      driverId: OTHER_DRIVER_ID,
      status: "DELIVERED",
    });
    deliveredToday.delivered_at = new Date();

    const deliveredYesterday = await seedDelivery(repos.deliveryRepository, {
      driverId: OTHER_DRIVER_ID,
      status: "DELIVERED",
    });
    deliveredYesterday.delivered_at = yesterday;

    // Nobody's yet: what the dispatcher still owes a route.
    await seedDelivery(repos.deliveryRepository, { driverId: null });

    // A foreign company's day never leaks in.
    await seedDelivery(repos.deliveryRepository, {
      businessId: OTHER_BUSINESS,
      status: "IN_TRANSIT",
    });

    const summary = await makeUseCase(
      repos,
      towerOf(repos, [designated.id!]),
    ).execute({ userId: MANAGER_ID });

    expect(summary.totals).toEqual({
      unassigned: 1,
      designated: 1,
      inRoute: 2,
      deliveredToday: 1,
      failedToday: 1,
      occurrencesToday: 0,
    });

    expect(summary.drivers.map((row) => row.driverName)).toEqual([
      "João Motorista",
      "Maria Motorista",
    ]);

    const joao = summary.drivers[0];
    expect(joao.inRoute).toBe(2);
    expect(joao.designated).toBe(1);
    expect(joao.failedToday).toBe(1);

    expect(summary.drivers[1].deliveredToday).toBe(1);
  });

  it("refuses a driver token — the whole operation is the manager's view", async () => {
    const repos = makeRepositories();

    await expect(
      makeUseCase(repos).execute({ userId: DRIVER_USER_ID }),
    ).rejects.toMatchObject({ code: "DRIVER_CANNOT_VIEW_PANELS" });
  });
});
