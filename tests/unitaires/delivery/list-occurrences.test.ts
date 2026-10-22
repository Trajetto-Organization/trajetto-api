import { describe, expect, it } from "vitest";

import { ListOccurrencesUseCase } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { UploadService } from "@/shared/services/upload-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * The occurrence feed over the in-memory twin: server-side order, facets and
 * cards (decision 8.8), with the twin held to the Prisma query's semantics —
 * newest first by default, the type name searchable, the `include` shape.
 * The same behaviour against Postgres is pinned in
 * tests/E2E/occurrence-feed-http.test.ts.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const MANAGER_ID = "018f0000-0000-7000-8000-0000000000a2";
const FOREIGN_MANAGER_ID = "018f0000-0000-7000-8000-0000000000a3";
const REPORTER_ID = "018f0000-0000-7000-8000-0000000000a1";

const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

const AUSENTE = "018f0000-0000-7000-8000-0000000000e1";
const RECUSA = "018f0000-0000-7000-8000-0000000000e2";
const FOREIGN_TYPE = "018f0000-0000-7000-8000-0000000000e3";

const uploadStub = {
  getFileUrl: async (key: string) => `http://storage.local/${key}`,
} as unknown as UploadService;

async function makeFeed() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();

  users.user.push(
    {
      id: MANAGER_ID,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: FOREIGN_MANAGER_ID,
      name: "Gestor de outra",
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    } as User,
  );

  deliveries.seedOccurrenceType({
    id: AUSENTE,
    businessId: BUSINESS,
    name: "Destinatário ausente",
    blocks_delivery: false,
  });
  deliveries.seedOccurrenceType({
    id: RECUSA,
    businessId: BUSINESS,
    name: "Recusa",
    blocks_delivery: true,
    requires_photo: true,
  });
  // Another company's catalog: its name must never reach this feed.
  deliveries.seedOccurrenceType({
    id: FOREIGN_TYPE,
    businessId: OTHER_BUSINESS,
    name: "Tipo secreto alheio",
    blocks_delivery: true,
  });
  deliveries.reporterNames.set(REPORTER_ID, "João Motorista");

  const seed = async (
    recipient: string,
    status: "IN_TRANSIT" | "FAILED",
    typeId: string,
    minutesAgo: number,
    businessId = BUSINESS,
  ) => {
    const delivery = await deliveries.createDelivery({
      recipient_name: recipient,
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      businessId,
      shipperId: SHIPPER_ID,
    } as CreateDeliveryProps);

    delivery.status = status;

    await deliveries.createOccurrence({
      deliveryId: delivery.id!,
      occurrenceTypeId: typeId,
      reportedById: REPORTER_ID,
    });

    // Spread in time, oldest seeded first, so insertion order is NOT the
    // expected default order.
    deliveries.occurrences[deliveries.occurrences.length - 1].created_at =
      new Date(Date.now() - minutesAgo * 60_000);

    return delivery;
  };

  await seed("Carla", "IN_TRANSIT", AUSENTE, 30);
  await seed("Ana", "FAILED", RECUSA, 20);
  await seed("Bruno", "IN_TRANSIT", AUSENTE, 10);
  await seed("De outra empresa", "FAILED", FOREIGN_TYPE, 5, OTHER_BUSINESS);

  const useCase = new ListOccurrencesUseCase(users, deliveries, uploadStub);

  const list = (input: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
    useCase.execute({ userId: MANAGER_ID, page: 1, pageSize: 10, ...input });

  return { list, useCase };
}

type FeedRow = {
  delivery: { recipient_name: string };
  occurrenceType: {
    name: string;
    blocks_delivery: boolean;
    requires_photo: boolean;
  };
  reportedBy: { name: string };
};

const recipients = (data: unknown[]) =>
  (data as FeedRow[]).map((row) => row.delivery.recipient_name);

describe("occurrence feed order", () => {
  it("defaults to newest first, not insertion order", async () => {
    const { list } = await makeFeed();

    expect(recipients((await list()).data)).toEqual(["Bruno", "Ana", "Carla"]);
  });

  it("sorts by the recipient on request, both ways", async () => {
    const { list } = await makeFeed();

    expect(
      recipients((await list({ sort: "recipient", order: "asc" })).data),
    ).toEqual(["Ana", "Bruno", "Carla"]);
    expect(
      recipients((await list({ sort: "recipient", order: "desc" })).data),
    ).toEqual(["Carla", "Bruno", "Ana"]);
  });

  it("breaks a tie on the sorted column by newest first", async () => {
    const { list } = await makeFeed();

    // Two "Destinatário ausente": Bruno (10 min) before Carla (30 min).
    expect(
      recipients((await list({ sort: "typeName", order: "asc" })).data),
    ).toEqual(["Bruno", "Carla", "Ana"]);
  });

  it("sorts the whole set before paging it", async () => {
    const { list } = await makeFeed();

    const second = await list({
      sort: "recipient",
      order: "asc",
      page: 2,
      pageSize: 2,
    });

    expect(recipients(second.data)).toEqual(["Carla"]);
    expect(second.total).toBe(3);
  });
});

describe("occurrence feed filters and cards", () => {
  it("returns rows in the shape of the Prisma include", async () => {
    const { list } = await makeFeed();

    const [first] = (await list()).data as FeedRow[];

    expect(first.occurrenceType).toMatchObject({
      name: "Destinatário ausente",
      blocks_delivery: false,
      requires_photo: false,
    });
    expect(first.reportedBy.name).toBe("João Motorista");

    // The type's own requires_photo, not a constant.
    const recusa = (
      (await list({ occurrenceTypeIds: [RECUSA] })).data as FeedRow[]
    )[0];

    expect(recusa.occurrenceType.requires_photo).toBe(true);
  });

  it("finds a row by the type's name, like the database search", async () => {
    const { list } = await makeFeed();

    const result = await list({ search: "recus" });

    expect(recipients(result.data)).toEqual(["Ana"]);
    expect(result.total).toBe(1);
  });

  it("filters by severity, type and delivery status on the whole set", async () => {
    const { list } = await makeFeed();

    expect(
      recipients((await list({ severity: ["informational"] })).data),
    ).toEqual(["Bruno", "Carla"]);
    expect(
      recipients((await list({ occurrenceTypeIds: [RECUSA] })).data),
    ).toEqual(["Ana"]);
    expect(
      recipients((await list({ deliveryStatuses: ["FAILED"] })).data),
    ).toEqual(["Ana"]);
  });

  it("keeps the cards whole under a severity filter", async () => {
    const { list } = await makeFeed();

    const result = await list({ severity: ["blocking"] });

    expect(result.total).toBe(1);
    expect(result.searchMeta).toMatchObject({
      total: 3,
      blocking: 1,
      informational: 2,
    });
  });

  it("counts the type options over the search and the other filters", async () => {
    const { list } = await makeFeed();

    const result = await list({ deliveryStatuses: ["IN_TRANSIT"] });

    expect(result.searchMeta.facets.occurrenceTypeId).toEqual([
      { value: AUSENTE, label: "Destinatário ausente", count: 2 },
    ]);
  });

  it("never counts another company's occurrences", async () => {
    const { list } = await makeFeed();

    const result = await list({ severity: ["blocking"] });

    // The foreign company's "Recusa" is not in the blocking card.
    expect(result.searchMeta.blocking).toBe(1);
  });

  it("never names another company's type, even when its id is selected", async () => {
    const { list } = await makeFeed();

    const result = await list({ occurrenceTypeIds: [FOREIGN_TYPE] });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(
      result.searchMeta.facets.occurrenceTypeId.map((option) => option.value),
    ).toEqual([AUSENTE, RECUSA]);
    expect(JSON.stringify(result)).not.toContain("Tipo secreto alheio");
  });

  it("keeps a selected type of the company listed at zero", async () => {
    const { list } = await makeFeed();

    const result = await list({
      occurrenceTypeIds: [RECUSA],
      deliveryStatuses: ["IN_TRANSIT"],
    });

    expect(result.searchMeta.facets.occurrenceTypeId).toContainEqual({
      value: RECUSA,
      label: "Recusa",
      count: 0,
    });
  });

  it("refuses a manager asking for another company", async () => {
    const { useCase } = await makeFeed();

    await expect(
      useCase.execute({
        userId: FOREIGN_MANAGER_ID,
        businessId: BUSINESS,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
