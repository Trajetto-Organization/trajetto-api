import { describe, expect, it } from "vitest";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Decision 14.7, D8 (design §4.13), on the in-memory twin the unit suite
 * uses: the driver's phone gets what is IN_TRANSIT, and what is PENDING on a
 * RELEASED or IN_PROGRESS route. A PLANNED route is a draft; a PENDING
 * delivery with a driver and no route is the old direct assignment. The
 * Postgres half is tests/E2E/route-lifecycle.test.ts.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000b1";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";

function repositoryWith(
  rows: Array<{ id: string; status: Delivery["status"]; routeStatus?: string }>,
) {
  const repository = new InMemoryDeliveryRepository();

  for (const row of rows) {
    repository.deliveries.push({
      id: row.id,
      businessId: BUSINESS,
      driverId: DRIVER,
      status: row.status,
      recipient_name: "Cliente",
    } as Delivery);

    if (row.routeStatus) {
      repository.routeStops.push({
        deliveryId: row.id,
        status: "PENDING",
        routeId: `route-of-${row.id}`,
        routeStatus: row.routeStatus,
      });
    }
  }

  return repository;
}

async function listedIds(repository: InMemoryDeliveryRepository): Promise<string[]> {
  const rows = (await repository.listDriverDeliveries(BUSINESS, DRIVER)) as Array<{ id: string }>;

  return rows.map((row) => row.id).sort();
}

describe("the driver's list on the in-memory twin (D8)", () => {
  it("shows IN_TRANSIT work and PENDING work on a released or started route", async () => {
    const repository = repositoryWith([
      { id: "a-transit-loose", status: "IN_TRANSIT" },
      { id: "b-pending-released", status: "PENDING", routeStatus: "RELEASED" },
      { id: "c-pending-started", status: "PENDING", routeStatus: "IN_PROGRESS" },
    ]);

    expect(await listedIds(repository)).toEqual([
      "a-transit-loose",
      "b-pending-released",
      "c-pending-started",
    ]);
  });

  it("leaves out a draft route and a PENDING delivery with no route", async () => {
    const repository = repositoryWith([
      { id: "d-pending-planned", status: "PENDING", routeStatus: "PLANNED" },
      { id: "e-pending-loose", status: "PENDING" },
    ]);

    expect(await listedIds(repository)).toEqual([]);
  });
});

describe("the routes of the driver's list (design §6)", () => {
  it("lists each route of an open stop once, with its plan version", async () => {
    const { routesOf } = await import(
      "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase"
    );

    const route = { id: "r1", code: 12, plan_version: 4, status: "RELEASED" };

    expect(
      routesOf([
        { id: "a", stops: [{ route }] },
        { id: "b", stops: [{ route }] },
        { id: "c", stops: [] },
        { id: "d", stops: [{ route: { id: "r2", code: 13, plan_version: 1 } }] },
      ]),
    ).toEqual([
      { id: "r1", code: 12, plan_version: 4 },
      { id: "r2", code: 13, plan_version: 1 },
    ]);
  });

  it("answers an empty list, not a missing key, when nothing is on a route", async () => {
    const { routesOf } = await import(
      "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase"
    );

    expect(routesOf([{ id: "a", stops: [] }, { id: "b" }])).toEqual([]);
  });
});
