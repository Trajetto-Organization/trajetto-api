import { describe, expect, it } from "vitest";

import {
  MIN_TAIL_LENGTH,
  idSearchConditions,
  idSearchOf,
  matchesIdSearch,
} from "@/shared/pagination/id-search";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import { routeListWhere } from "@/modules/route/usecases/list-routes/route-list";
import { vehicleListWhere } from "@/modules/vehicle/usecases/list-vehicle/vehicle-list";
import { vehicleTypeListWhere } from "@/modules/vehicle-type/usecases/list-vehicle-type/vehicle-type-list";
import { checklistListWhere } from "@/modules/vehicle-checklist/usecases/list-vehicle-checklist/checklist-list";

/**
 * Searching a list by the id its table shows (spec §5).
 *
 * The web shows every record's id compact — the last twelve characters of
 * the UUID — and "Copiar ID" copies the whole one. Rotas did not match the id
 * at all; Veículos, Tipos de veículo and Checklists matched only an exact
 * full UUID, case-sensitively: the compact id and an upper-case paste found
 * nothing. Only a term shaped like an id adds a condition, so a name or a
 * plate searches exactly as before.
 */
const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

const ID = "019a2f3c-7d8e-7abc-9def-279d9fb8f0bd";
const TAIL = "279d9fb8f0bd";
/** Another company's record that happens to end the same way. */
const FOREIGN_SAME_TAIL = "019a2f3c-1111-7abc-8aaa-279d9fb8f0bd";

describe("idSearchOf", () => {
  it("reads a whole UUID, in any case, as the lowercased id", () => {
    expect(idSearchOf(ID)).toEqual({ kind: "exact", id: ID });
    expect(idSearchOf(` ${ID.toUpperCase()} `)).toEqual({
      kind: "exact",
      id: ID,
    });
  });

  it("reads the tail the table shows, and longer tails with their dashes", () => {
    expect(idSearchOf(TAIL)).toEqual({ kind: "tail", tail: TAIL });
    expect(idSearchOf(TAIL.toUpperCase())).toEqual({
      kind: "tail",
      tail: TAIL,
    });
    expect(idSearchOf("9def-279d9fb8f0bd")).toEqual({
      kind: "tail",
      tail: "9def-279d9fb8f0bd",
    });
    expect(idSearchOf("-279d9fb8f0bd")).toEqual({
      kind: "tail",
      tail: "-279d9fb8f0bd",
    });
    // Eight hex digits are the shortest tail.
    expect(MIN_TAIL_LENGTH).toBe(8);
    expect(idSearchOf("9fb8f0bd")).toEqual({ kind: "tail", tail: "9fb8f0bd" });
  });

  it("reads nothing else as an id", () => {
    for (const term of [
      "",
      "   ",
      "abc",
      "2024",
      "9fb8f0b", // seven digits: too short to mean a record
      "279d9fb8f0bz", // not hex
      "Truck",
      "ABC1D23", // a plate
      "279d9fb8f0bd9", // 13 hex digits with no dash: no UUID ends like that
      "9def279d9fb8f0bd", // the dash missing where a UUID has one
      `${ID}0`, // longer than a UUID
      "35240912345678000190550010000012341000012345", // an NF-e key
    ]) {
      expect(idSearchOf(term), term).toBeNull();
      expect(idSearchConditions(term), term).toEqual([]);
    }
  });
});

describe("idSearchConditions and matchesIdSearch", () => {
  it("is equality on the key for a whole id, endsWith for a tail", () => {
    expect(idSearchConditions(ID.toUpperCase())).toEqual([{ id: ID }]);
    expect(idSearchConditions(TAIL)).toEqual([
      { id: { endsWith: TAIL, mode: "insensitive" } },
    ]);
  });

  it("answers in memory what Postgres answers", () => {
    expect(matchesIdSearch(ID, ID.toUpperCase())).toBe(true);
    expect(matchesIdSearch(ID, TAIL)).toBe(true);
    expect(matchesIdSearch(ID, TAIL.toUpperCase())).toBe(true);
    expect(matchesIdSearch(ID, "9fb8f0bd")).toBe(true);
    expect(matchesIdSearch(ID, "0000000009a4")).toBe(false);
    expect(matchesIdSearch(ID, "Rota")).toBe(false);
    // Equality is exact in Postgres: a stored id is lower case.
    expect(matchesIdSearch(ID.toUpperCase(), ID)).toBe(false);
  });
});

describe("the four lists that did not find the id they show", () => {
  const builders = {
    routes: (search: string) => routeListWhere({ businessId: CARRIER, search }),
    vehicles: (search: string) =>
      vehicleListWhere({ businessId: CARRIER, search }),
    "vehicle types": (search: string) =>
      vehicleTypeListWhere({ businessId: CARRIER, search }),
    checklists: (search: string) =>
      checklistListWhere({ businessId: CARRIER, search }),
  };

  it.each(Object.entries(builders))(
    "%s: search by the tail and by the whole id, the tenant kept on top",
    (_name, where) => {
      const byTail = where(TAIL);
      const byId = where(ID.toUpperCase());

      expect(byTail.businessId).toBe(CARRIER);
      expect(byId.businessId).toBe(CARRIER);
      expect(JSON.stringify(byTail)).toContain(
        JSON.stringify({ id: { endsWith: TAIL, mode: "insensitive" } }),
      );
      expect(JSON.stringify(byId)).toContain(JSON.stringify({ id: ID }));

      // A name adds no condition on the key.
      expect(JSON.stringify(where("Rota Norte"))).not.toContain('"id"');
    },
  );

  it("routes: a 12-digit tail is not read as a route number", () => {
    const where = routeListWhere({
      businessId: CARRIER,
      search: "000000000042",
    });

    expect(JSON.stringify(where)).not.toContain('"code"');
    expect(JSON.stringify(where)).toContain('"endsWith":"000000000042"');
  });
});

describe("the in-memory twins find the id too, never another company's", () => {
  it("routes", async () => {
    const repository = new InMemoryRouteRepository();

    for (const [id, businessId] of [
      [ID, CARRIER],
      [FOREIGN_SAME_TAIL, OTHER],
      ["019a2f3c-7d8e-7abc-9def-00000000aaaa", CARRIER],
    ] as const) {
      const created = await repository.createRoute({
        businessId,
        driverId: "drv",
        scheduled_date: new Date("2026-10-28"),
        deliveryIds: [],
      });

      repository.routes.find((route) => route.id === created.id)!.id = id;
    }

    const ids = async (search: string) =>
      (
        await repository.listRoutes({
          businessId: CARRIER,
          page: 1,
          pageSize: 10,
          search,
        })
      ).data.map((route) => route.id);

    // Red before: the board matched name, destination, driver and number.
    expect(await ids(TAIL)).toEqual([ID]);
    expect(await ids(ID.toUpperCase())).toEqual([ID]);
    expect(await ids(FOREIGN_SAME_TAIL)).toEqual([]);
  });

  it("vehicles", async () => {
    const repository = new InMemoryVehicleRepository();

    repository.vehicles.push(
      { id: ID, businessId: CARRIER, created_at: new Date() } as never,
      {
        id: FOREIGN_SAME_TAIL,
        businessId: OTHER,
        created_at: new Date(),
      } as never,
    );

    const ids = async (search: string) =>
      (
        await repository.listVehicles({
          businessId: CARRIER,
          page: 1,
          pageSize: 10,
          search,
        })
      ).data.map((vehicle) => vehicle.id);

    // Red before: only an exact whole UUID matched.
    expect(await ids(TAIL)).toEqual([ID]);
    expect(await ids(ID.toUpperCase())).toEqual([ID]);
  });

  it("vehicle types", async () => {
    const repository = new InMemoryVehicleTypeRepository();

    repository.vehicleTypes.push(
      {
        id: ID,
        businessId: CARRIER,
        description: "Truck",
        created_at: new Date(),
      } as never,
      {
        id: FOREIGN_SAME_TAIL,
        businessId: OTHER,
        description: "Truck alheio",
        created_at: new Date(),
      } as never,
    );

    const ids = async (search: string) =>
      (
        await repository.listVehicleTypes({
          businessId: CARRIER,
          page: 1,
          pageSize: 10,
          search,
        })
      ).data.map((type) => type.id);

    expect(await ids(TAIL)).toEqual([ID]);
    expect(await ids(ID.toUpperCase())).toEqual([ID]);
  });

  it("checklists", async () => {
    const repository = new InMemoryVehicleChecklistRepository();

    repository.checklists.push(
      {
        id: ID,
        businessId: CARRIER,
        vehicleId: "veh",
        driverId: "drv",
        branchId: "br",
        overall_condition: "approved",
        created_at: new Date(),
        checklist_date: new Date(),
      } as never,
      {
        id: FOREIGN_SAME_TAIL,
        businessId: OTHER,
        vehicleId: "veh",
        driverId: "drv",
        branchId: "br",
        overall_condition: "approved",
        created_at: new Date(),
        checklist_date: new Date(),
      } as never,
    );

    const ids = async (search: string) =>
      (
        await repository.listVehicleChecklists({
          businessId: CARRIER,
          page: 1,
          pageSize: 10,
          search,
        })
      ).data.map((checklist) => checklist.id);

    expect(await ids(TAIL)).toEqual([ID]);
    expect(await ids(ID.toUpperCase())).toEqual([ID]);
  });
});
