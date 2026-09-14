import { describe, expect, it } from "vitest";

import { ListOccurrencesUseCase } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-usecase";
import { OperationSummaryUseCase } from "@/modules/delivery/usecases/operation-summary/operation-summary-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

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

  deliveryRepository.occurrenceTypeBlocking.set(TYPE_BLOCKING, true);
  deliveryRepository.occurrenceTypeBlocking.set(TYPE_INFO, false);

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
      blocksDelivery: true,
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

  it("shows a driver only their own deliveries' occurrences", async () => {
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
  function makeUseCase(repos: ReturnType<typeof makeRepositories>) {
    return new OperationSummaryUseCase(
      repos.userRepository,
      repos.deliveryRepository,
    );
  }

  it("counts the day per driver, busiest first", async () => {
    const repos = makeRepositories();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // João: two in route, one designated, one failed today.
    await seedDelivery(repos.deliveryRepository, { status: "IN_TRANSIT" });
    await seedDelivery(repos.deliveryRepository, { status: "IN_TRANSIT" });
    await seedDelivery(repos.deliveryRepository, { status: "PENDING" });
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

    const summary = await makeUseCase(repos).execute({ userId: MANAGER_ID });

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
