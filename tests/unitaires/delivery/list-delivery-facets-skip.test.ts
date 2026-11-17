import { describe, expect, it, vi } from "vitest";

import { ListDeliveryUseCase } from "@/modules/delivery/usecases/list-delivery/list-delivery-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * `facets=skip` on the deliveries listing (plano-escala F2-30).
 *
 * The counts of the board (cards, filter options, the pager total) are
 * the heaviest read of the screen, and they do not change when the person
 * only turns the page. A client that already has them asks page 2 with
 * `facets=skip`: the same rows, under the same scope and period, and
 * nothing counted. The Prisma side is pinned by statements in
 * tests/E2E/delivery-list-facets-skip.test.ts; the twin follows it here.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000c1";
const OTHER = "018f0000-0000-7000-8000-0000000000c2";
const MANAGER = "018f0000-0000-7000-8000-0000000000c3";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000c4";
const DRIVER = "018f0000-0000-7000-8000-0000000000c5";
const SHIPPER = "018f0000-0000-7000-8000-0000000000c6";

function build() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();

  users.user.push(
    {
      id: MANAGER,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  deliveries.shipperNames.set(SHIPPER, "Atacado Sul");

  for (let index = 0; index < 7; index += 1) {
    deliveries.deliveries.push({
      id: `delivery-${index}`,
      businessId: BUSINESS,
      shipperId: SHIPPER,
      driverId: index % 2 === 0 ? DRIVER : null,
      recipient_name: `Cliente ${index}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: index % 3 === 0 ? "DELIVERED" : "PENDING",
      created_at: new Date(Date.UTC(2026, 8, 1, 12, index)),
    } as never);
  }

  deliveries.deliveries.push({
    id: "delivery-foreign",
    businessId: OTHER,
    shipperId: SHIPPER,
    recipient_name: "Cliente alheio",
    city: "Rio",
    uf: "RJ",
    street: "Rua",
    status: "PENDING",
    created_at: new Date(),
  } as never);

  const listing = vi.spyOn(deliveries, "listDeliveries");

  return {
    useCase: new ListDeliveryUseCase(
      users,
      deliveries,
      new InMemoryBusinessRepository(),
    ),
    listing,
  };
}

const ids = (rows: Array<{ id?: string }>) => rows.map((row) => row.id);

describe("a page read with facets=skip", () => {
  it("brings the same rows as the counted read, and no count at all", async () => {
    const { useCase, listing } = build();

    const counted = await useCase.execute({
      userId: MANAGER,
      page: 2,
      pageSize: 3,
    });
    const skipped = await useCase.executePageOnly({
      userId: MANAGER,
      page: 2,
      pageSize: 3,
    });

    expect(ids(skipped.data)).toEqual(ids(counted.data));
    expect(skipped.data).toHaveLength(3);

    expect(skipped).not.toHaveProperty("total");
    expect(skipped.meta).toEqual({ facetsSkipped: true, period: null });

    // The repository was asked to skip, and nothing else.
    expect(listing.mock.calls[1][0]).toMatchObject({
      page: 2,
      pageSize: 3,
      businessId: BUSINESS,
      skipFacets: true,
    });
    expect(listing.mock.calls[1][0]).not.toHaveProperty("leftOpenBefore");
  });

  it("keeps the driver's own scope and the company's period", async () => {
    const { useCase } = build();

    const skipped = await useCase.executePageOnly({
      userId: DRIVER_USER,
      page: 1,
      pageSize: 50,
      period: "30d",
    });

    expect(skipped.data.every((row) => row.driverId === DRIVER)).toBe(true);
    expect(skipped.meta.period).toMatchObject({ applied: true });
  });

  it("never lists another company's rows", async () => {
    const { useCase } = build();

    const skipped = await useCase.executePageOnly({
      userId: MANAGER,
      page: 1,
      pageSize: 100,
    });

    expect(ids(skipped.data)).not.toContain("delivery-foreign");
  });
});

describe("the in-memory twin", () => {
  it("returns empty counts and says it skipped them", async () => {
    const repository = new InMemoryDeliveryRepository();

    const page = await repository.listDeliveries({
      businessId: BUSINESS,
      page: 1,
      pageSize: 10,
      skipFacets: true,
    });

    expect(page).toMatchObject({
      statusCounts: [],
      shipperOptions: [],
      driverOptions: [],
      facetsSkipped: true,
    });
  });
});
