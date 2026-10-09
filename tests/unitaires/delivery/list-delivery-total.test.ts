import { describe, expect, it, vi } from "vitest";

import { ListDeliveryUseCase } from "@/modules/delivery/usecases/list-delivery/list-delivery-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The deliveries table on the server (decisions 5.8 and 8.8).
 *
 * The total under the table and the status cards come from ONE grouped count
 * of the company (never from the loaded page), the cards follow the
 * disjunctive rule (every filter but their own), and the filters offer the
 * company's shippers and drivers with the counts they would bring.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000b1";
const OTHER = "018f0000-0000-7000-8000-0000000000b2";
const MANAGER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f0000-0000-7000-8000-0000000000f2";
const FOREIGN_SHIPPER = "018f0000-0000-7000-8000-0000000000f9";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";

function build() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();

  users.user.push(
    { id: MANAGER, name: "Gestora", role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  deliveries.shipperNames.set(SHIPPER, "Atacado Sul");
  deliveries.shipperNames.set(OTHER_SHIPPER, "Bebidas Norte");
  deliveries.shipperNames.set(FOREIGN_SHIPPER, "Embarcador de outra empresa");
  deliveries.driverDirectory.set(DRIVER, { name: "João Motorista", cnh: "12345678900" });

  const rows: Array<[string, string, string | null]> = [
    ["PENDING", SHIPPER, null],
    ["PENDING", SHIPPER, DRIVER],
    ["IN_TRANSIT", SHIPPER, DRIVER],
    ["DELIVERED", OTHER_SHIPPER, DRIVER],
    ["FAILED", OTHER_SHIPPER, null],
  ];

  for (const [index, [status, shipperId, driverId]] of rows.entries()) {
    deliveries.deliveries.push({
      id: `delivery-${index}`,
      businessId: BUSINESS,
      shipperId,
      driverId,
      recipient_name: `Cliente ${index}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status,
      created_at: new Date(Date.UTC(2026, 8, 1, 12, index)),
    } as never);
  }

  // Another company's row: never counted, never named.
  deliveries.deliveries.push({
    id: "delivery-foreign",
    businessId: OTHER,
    shipperId: FOREIGN_SHIPPER,
    recipient_name: "Cliente alheio",
    city: "Rio",
    uf: "RJ",
    street: "Rua",
    status: "PENDING",
    created_at: new Date(),
  } as never);

  const listing = vi.spyOn(deliveries, "listDeliveries");

  return { useCase: new ListDeliveryUseCase(users, deliveries), listing };
}

describe("the pager total and the cards", () => {
  it("come from the whole company, not from the loaded page", async () => {
    const { useCase, listing } = build();

    const result = await useCase.execute({ userId: MANAGER, page: 1, pageSize: 2 });

    expect(listing).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.meta?.statusCounts).toEqual({
      PENDING: 2,
      IN_TRANSIT: 1,
      DELIVERED: 1,
      FAILED: 1,
    });
  });

  it("keep the other statuses whole when one status is chosen (disjunctive rule)", async () => {
    const { useCase } = build();

    const result = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      statuses: ["PENDING", "FAILED"],
    });

    expect(result.total).toBe(3);
    expect(result.data.map((row) => row.status).sort()).toEqual([
      "FAILED",
      "PENDING",
      "PENDING",
    ]);
    expect(result.meta?.statusCounts.DELIVERED).toBe(1);
  });

  it("follow the other filters and the search", async () => {
    const { useCase } = build();

    const byShipper = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      shipperIds: [OTHER_SHIPPER],
    });

    expect(byShipper.total).toBe(2);
    expect(byShipper.meta?.statusCounts).toEqual({ DELIVERED: 1, FAILED: 1 });

    // The search reaches the driver's name, like the Prisma query.
    const byDriverName = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      search: "joão motor",
    });

    expect(byDriverName.total).toBe(3);

    // And the id copied from the row menu.
    const byId = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      search: "delivery-3",
    });

    expect(byId.data.map((row) => row.id)).toEqual(["delivery-3"]);
  });
});

describe("the filter options", () => {
  it("name the company's shippers and drivers, with what each would bring", async () => {
    const { useCase } = build();

    const result = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      statuses: ["PENDING"],
    });

    expect(result.meta?.facets.shipperId).toEqual([
      { value: SHIPPER, label: "Atacado Sul", count: 2 },
    ]);

    expect(result.meta?.facets.driverId).toEqual([
      { value: DRIVER, label: "João Motorista", count: 1 },
    ]);

    expect(result.meta?.facets.status).toContainEqual({
      value: "IN_TRANSIT",
      count: 1,
    });
  });

  it("never names another company's shipper, even when its id is sent", async () => {
    const { useCase } = build();

    const result = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      shipperIds: [FOREIGN_SHIPPER],
    });

    expect(result.total).toBe(0);
    expect(
      result.meta?.facets.shipperId.map((option) => option.label),
    ).not.toContain("Embarcador de outra empresa");
  });
});

describe("the order", () => {
  it("defaults to the newest first and sorts on the server by a column", async () => {
    const { useCase } = build();

    const newest = await useCase.execute({ userId: MANAGER, page: 1, pageSize: 2 });

    expect(newest.data.map((row) => row.id)).toEqual(["delivery-4", "delivery-3"]);

    const byShipper = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 5,
      sort: "shipperName",
      order: "desc",
    });

    expect(byShipper.data.slice(0, 2).map((row) => row.shipperId)).toEqual([
      OTHER_SHIPPER,
      OTHER_SHIPPER,
    ]);
  });
});

describe("a driver", () => {
  it("lists only what they carry, whatever driver filter the URL brings", async () => {
    const { useCase } = build();

    const result = await useCase.execute({
      userId: DRIVER_USER,
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(3);
    expect(result.data.every((row) => row.driverId === DRIVER)).toBe(true);
  });
});
