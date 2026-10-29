import { describe, expect, it } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import {
  tallyStatuses,
  isVehicleOutOfOperation,
} from "@/shared/vehicle/vehicle-rules";
import { summarizeVehicleList } from "@/modules/vehicle/usecases/list-vehicle/vehicle-list";

import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

/*
 * "A vehicle out of operation cannot take new cargo" lived here too, through
 * the create and edit of a delivery. Those forms no longer carry a vehicle or
 * a driver (DLV-EDIT-4, proven by the schemas in delivery-edit-rules.test.ts):
 * the only door is the assignment, whose refusal of a blocked vehicle is
 * covered by the route and assignment suites.
 */

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";

const GOOD_VEHICLE = "018f0000-0000-7000-8000-0000000000c1";

function seedVehicle(
  repository: InMemoryVehicleRepository,
  overrides: Partial<Vehicle> = {},
): Vehicle {
  const vehicle = {
    id: GOOD_VEHICLE,
    description: "Caminhão",
    license_plate: "ABC1D23",
    brand: "Volvo",
    model: "FH",
    renavam: "1",
    status: "ACTIVE",
    businessId: BUSINESS,
    ...overrides,
  } as Vehicle;

  repository.vehicles.push(vehicle);
  return vehicle;
}

describe("vehicle status tally", () => {
  it("fills the statuses that have no rows instead of leaving them undefined", () => {
    // A fleet with nothing blocked produces no BLOCKED group at all; the card
    // has to read 0, not undefined.
    const counts = tallyStatuses([{ status: "ACTIVE", _count: { _all: 7 } }]);

    expect(counts).toEqual({
      ACTIVE: 7,
      INACTIVE: 0,
      BLOCKED: 0,
      IN_ROUTE: 0,
    });
  });

  it("counts the whole fleet, not the page on screen", async () => {
    const repository = new InMemoryVehicleRepository();

    // Forty active vehicles, ten to a page: the cards used to filter the page
    // array and report "10 (25%)" for a fleet that is 100% active.
    for (let index = 0; index < 40; index += 1) {
      seedVehicle(repository, {
        id: `018f0000-0000-7000-8000-0000000${index.toString().padStart(5, "0")}`,
        license_plate: `ABC1D${index.toString().padStart(2, "0")}`,
        renavam: String(index),
      });
    }

    const listed = await repository.listVehicles({
      page: 1,
      pageSize: 10,
      businessId: BUSINESS,
    });

    const { total } = summarizeVehicleList(listed.statusCounts, [], {});

    expect(listed.data).toHaveLength(10);
    expect(total).toBe(40);
    expect(listed.statusCounts.ACTIVE).toBe(40);
  });

  it("keeps the four counts adding up to the total under a search filter", async () => {
    const repository = new InMemoryVehicleRepository();

    seedVehicle(repository, {
      id: "v1",
      license_plate: "AAA1A11",
      renavam: "1",
    });
    seedVehicle(repository, {
      id: "v2",
      license_plate: "AAA2A22",
      renavam: "2",
      status: "BLOCKED",
    });
    seedVehicle(repository, {
      id: "v3",
      license_plate: "ZZZ9Z99",
      renavam: "3",
      status: "INACTIVE",
    });

    const listed = await repository.listVehicles({
      page: 1,
      pageSize: 10,
      businessId: BUSINESS,
      search: "AAA",
    });

    const { total } = summarizeVehicleList(listed.statusCounts, [], {});
    const { ACTIVE, INACTIVE, BLOCKED, IN_ROUTE } = listed.statusCounts;

    expect(ACTIVE + INACTIVE + BLOCKED + IN_ROUTE).toBe(total);
    expect(total).toBe(2);
  });

  it("does not treat a vehicle already on the street as out of operation", () => {
    expect(isVehicleOutOfOperation("IN_ROUTE")).toBe(false);
    expect(isVehicleOutOfOperation("ACTIVE")).toBe(false);
    expect(isVehicleOutOfOperation("INACTIVE")).toBe(true);
    expect(isVehicleOutOfOperation("BLOCKED")).toBe(true);
  });
});
