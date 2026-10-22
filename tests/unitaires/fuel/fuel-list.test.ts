import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

import {
  FUEL_FACET_OPTION_LIMIT,
  fuelListWhere,
  labelIdsOf,
  summarizeFuelList,
  type FuelListGroup,
  type FuelListLabels,
} from "@/modules/fuel/usecases/list-fuel/fuel-list";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";

/**
 * The refuelings list's server-side rules (decision 8.8), as pure functions
 * and on the in-memory twin, which must answer as the Postgres repository
 * does (decision 13.2; the E2E fuel-list-http proves the repository).
 */
const A = "018fe500-0000-7000-8000-00000000000a";
const B = "018fe500-0000-7000-8000-00000000000b";

const CENTRO = "br-centro";
const NORTE = "br-norte";

const group = (overrides: Partial<FuelListGroup>): FuelListGroup => ({
  branchId: CENTRO,
  vehicleId: "v1",
  fuelTypeId: "diesel",
  odometer_verified: false,
  count: 1,
  liters: "10",
  amount: "55",
  ...overrides,
});

const LABELS: FuelListLabels = {
  branchId: { [CENTRO]: "Filial Centro", [NORTE]: "Filial Norte" },
  vehicleId: { v1: "AAA1A11", v2: "BBB2B22" },
  fuelTypeId: { diesel: "Diesel", gasolina: "Gasolina" },
};

describe("summarizeFuelList", () => {
  const groups = [
    group({
      count: 3,
      liters: "30.5",
      amount: "167.75",
      odometer_verified: true,
    }),
    group({
      branchId: NORTE,
      vehicleId: "v2",
      count: 2,
      liters: "20.25",
      amount: "111.38",
    }),
    group({
      branchId: NORTE,
      fuelTypeId: "gasolina",
      count: 1,
      liters: "0.1",
      amount: "0.2",
    }),
  ];

  it("adds up every group for the cards, in decimal (no float drift)", () => {
    const { total, searchMeta } = summarizeFuelList(groups, LABELS, {});

    expect(total).toBe(6);
    expect(searchMeta.totalLiters).toBe(50.85);
    expect(searchMeta.totalAmount).toBe(279.33);
    expect(searchMeta.verifiedOdometer).toBe(3);
  });

  it("counts a facet's options without its own selection (disjunctive)", () => {
    const { total, searchMeta } = summarizeFuelList(groups, LABELS, {
      branchIds: [CENTRO],
    });

    expect(total).toBe(3);
    expect(searchMeta.facets.branchId).toEqual([
      { value: CENTRO, label: "Filial Centro", count: 3 },
      { value: NORTE, label: "Filial Norte", count: 3 },
    ]);
    // The other facets are counted under the branch selection.
    expect(searchMeta.facets.vehicleId).toEqual([
      { value: "v1", label: "AAA1A11", count: 3 },
    ]);
  });

  it("keeps a selected option that has no rows now, with 0, if the company names it", () => {
    const { searchMeta } = summarizeFuelList(groups, LABELS, {
      vehicleIds: ["v2"],
      fuelTypeIds: ["gasolina"],
    });

    expect(searchMeta.facets.vehicleId).toContainEqual({
      value: "v2",
      label: "BBB2B22",
      count: 0,
    });
  });

  it("drops an option the company's catalog does not name (another company's id)", () => {
    const { total, searchMeta } = summarizeFuelList(groups, LABELS, {
      branchIds: ["foreign-branch"],
    });

    expect(total).toBe(0);
    expect(
      searchMeta.facets.branchId.map((option) => option.value),
    ).not.toContain("foreign-branch");
  });

  it("asks labels for the selected ids, then the ones with rows, busiest first", () => {
    expect(labelIdsOf(groups, { fuelTypeIds: ["etanol"] }).fuelTypeId).toEqual([
      "etanol",
      "diesel",
      "gasolina",
    ]);
  });
});

describe("a large fleet's filter options", () => {
  // 150 vehicles, vehicle i refueled i + 1 times: v149 is the busiest.
  const fleet = Array.from({ length: 150 }, (_, i) =>
    group({ vehicleId: `v${i}`, count: i + 1 }),
  );
  const plates: FuelListLabels = {
    ...LABELS,
    vehicleId: Object.fromEntries(
      fleet.map((row) => [row.vehicleId, `P${row.vehicleId}`]),
    ),
  };

  it(`offers the ${FUEL_FACET_OPTION_LIMIT} busiest vehicles, not every plate that ever refueled`, () => {
    const { searchMeta } = summarizeFuelList(fleet, plates, {});
    const offered = searchMeta.facets.vehicleId.map((option) => option.value);

    expect(offered).toHaveLength(FUEL_FACET_OPTION_LIMIT);
    expect(offered).toContain("v149");
    expect(offered).toContain("v50");
    expect(offered).not.toContain("v49");

    // Totals still count every refueling, offered or not.
    expect(searchMeta.total).toBe((150 * 151) / 2);
  });

  it("always keeps a selected vehicle, even a quiet one, with its count", () => {
    const { searchMeta } = summarizeFuelList(fleet, plates, {
      vehicleIds: ["v0"],
    });
    const offered = searchMeta.facets.vehicleId;

    expect(offered).toHaveLength(FUEL_FACET_OPTION_LIMIT);
    expect(offered).toContainEqual({ value: "v0", label: "Pv0", count: 1 });
  });

  it("looks up only the names it offers", () => {
    const ids = labelIdsOf(fleet, { vehicleIds: ["v0"] }).vehicleId;

    expect(ids).toHaveLength(FUEL_FACET_OPTION_LIMIT);
    expect(ids[0]).toBe("v0");
    expect(ids).not.toContain("v1");
  });
});

describe("fuelListWhere", () => {
  it("keeps the tenant at the top, outside every OR", () => {
    const where = fuelListWhere(
      { businessId: A, search: "abc", branchIds: [CENTRO] },
      { withFacets: true },
    );

    expect(where.businessId).toBe(A);
    expect(JSON.stringify(where.AND)).toContain(CENTRO);
  });

  it("scopes a driver to their own refuelings", () => {
    const where = fuelListWhere(
      { businessId: A, driverId: "d1" },
      { withFacets: false },
    );

    expect(where.AND).toContainEqual({ driverId: "d1" });
  });

  it("leaves the facets out of the base the counts are grouped over", () => {
    const where = fuelListWhere(
      { businessId: A, vehicleIds: ["v1"] },
      { withFacets: false },
    );

    expect(where).toEqual({ businessId: A });
  });

  it("escapes LIKE wildcards in the search term", () => {
    const where = fuelListWhere(
      { businessId: A, search: "50%" },
      { withFacets: true },
    );

    expect(JSON.stringify(where)).toContain("50\\\\%");
  });
});

describe("InMemoryFuelRepository.listFuels matches the repository", () => {
  function seeded() {
    const repo = new InMemoryFuelRepository();
    const base = Date.parse("2026-09-01T12:00:00Z");

    repo.branches.set(CENTRO, {
      businessId: A,
      corporate_reason: "Filial Centro",
    });
    repo.branches.set(NORTE, {
      businessId: A,
      corporate_reason: "Filial Norte",
    });
    repo.vehicles.set("v1", {
      businessId: A,
      license_plate: "AAA1A11",
      description: "Caminhão",
      brand: "Marca",
      model: "Modelo",
    });
    repo.vehicles.set("v2", {
      businessId: A,
      license_plate: "BBB2B22",
      description: "Van",
      brand: "Marca",
      model: "Modelo",
    });
    repo.drivers.set("d1", { name: "Ana", cnh: "111" });
    repo.fuelTypes.set("diesel", { businessId: A, description: "Diesel" });

    for (let i = 0; i < 12; i += 1) {
      repo.fuels.push({
        id: `018fe500-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`,
        current_mileage: 1000 + i,
        liters_amount: new Decimal(10 + i),
        price_per_liter: new Decimal(5.5),
        total_amount: new Decimal((10 + i) * 5.5),
        odometer_verified: i % 3 === 0,
        odometer_ai_status: "pending",
        refueling_date: new Date(base - i * 86_400_000),
        businessId: A,
        branchId: i % 2 === 0 ? CENTRO : NORTE,
        vehicleId: i % 2 === 0 ? "v1" : "v2",
        driverId: "d1",
        fuelTypeId: "diesel",
        created_from: "WEB_DASHBOARD",
        // Two pairs share a timestamp: the id breaks the tie, newest first.
        created_at: new Date(base + Math.floor(i / 2) * 60_000),
        updated_at: new Date(base),
      });
    }

    repo.fuels.push({
      ...repo.fuels[0],
      id: "018fe500-0000-7000-8000-000000000999",
      businessId: B,
    });

    return repo;
  }

  it("orders by created_at desc with the id as tiebreaker, paging after sorting", async () => {
    const repo = seeded();
    const { data } = await repo.listFuels({
      page: 1,
      pageSize: 4,
      businessId: A,
    });

    expect(data.map((row) => row.id.slice(-2))).toEqual([
      "11",
      "10",
      "09",
      "08",
    ]);
  });

  it("sorts by a relation column and filters by facet and search like Postgres", async () => {
    const repo = seeded();

    const byPlate = await repo.listFuels({
      page: 1,
      pageSize: 12,
      businessId: A,
      sort: "vehicle_license_plate",
      order: "desc",
    });

    expect(byPlate.data[0].vehicleId).toBe("v2");

    const filtered = await repo.listFuels({
      page: 1,
      pageSize: 12,
      businessId: A,
      branchIds: [NORTE],
      search: "van",
    });

    expect(filtered.data).toHaveLength(6);
    expect(filtered.data.every((row) => row.branchId === NORTE)).toBe(true);
  });

  it("groups the base (without facets) and names only the company's rows", async () => {
    const repo = seeded();
    repo.branches.set("foreign", { businessId: B, corporate_reason: "Alheia" });

    const { groups, labels } = await repo.listFuels({
      page: 1,
      pageSize: 10,
      businessId: A,
      branchIds: ["foreign"],
    });

    const { total, searchMeta } = summarizeFuelList(groups, labels, {
      branchIds: ["foreign"],
    });

    expect(total).toBe(0);
    expect(labels.branchId.foreign).toBeUndefined();
    expect(searchMeta.facets.branchId.map((option) => option.count)).toEqual([
      6, 6,
    ]);
  });

  it("exports with the same filters", async () => {
    const repo = seeded();
    const rows: unknown[] = [];

    for await (const row of repo.streamFuelsForExport({
      businessId: A,
      vehicleIds: ["v1"],
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(6);
    expect(
      await repo.countFuelForExport({ businessId: A, vehicleIds: ["v1"] }),
    ).toBe(6);
  });
});

describe("InMemoryFuelRepository keeps what Postgres keeps", () => {
  const refueling = (overrides: Record<string, unknown> = {}) => ({
    current_mileage: 1000,
    liters_amount: 45.237,
    price_per_liter: 5.899,
    refueling_date: new Date("2026-09-01T12:00:00Z"),
    businessId: A,
    branchId: CENTRO,
    vehicleId: "v1",
    driverId: "d1",
    fuelTypeId: "diesel",
    created_from: "WEB_DASHBOARD" as const,
    ...overrides,
  });

  it("stores the total with two decimals, rounded half up (Decimal(10, 2))", async () => {
    // Red before: 266.853063 in the twin against 266.85 in the column, so
    // the twin's cards and export totals drifted from the database's.
    const repo = new InMemoryFuelRepository();
    const fuel = await repo.createFuel(refueling());

    expect(fuel.total_amount.toString()).toBe("266.85");

    const updated = await repo.updateFuel({
      fuelId: fuel.id,
      fuelData: { price_per_liter: 5.905 },
    });

    // 45.237 × 5.905 = 267.124485 → 267.12
    expect(updated.total_amount.toString()).toBe("267.12");

    const halfUp = await repo.createFuel(
      refueling({ liters_amount: 1, price_per_liter: 0.125 }),
    );

    expect(halfUp.total_amount.toString()).toBe("0.13");
  });

  it("answers a cursor that names no row with an empty page, not the first one", async () => {
    // Red before: an unknown cursor restarted from the top, so a client that
    // kept paging after a deletion read the whole history again.
    const repo = new InMemoryFuelRepository();

    await repo.createFuel(refueling());
    await repo.createFuel(refueling({ current_mileage: 1100 }));

    const page = await repo.searchFuelByVehicleWithCursor({
      limit: 10,
      vehicleId: "v1",
      businessId: A,
      cursor: "018fe500-0000-7000-8000-00000000dead",
    });

    expect(page).toEqual({ data: [], nextCursor: null, hasMore: false });
  });

  it("exports through the shared comparator, not localeCompare", async () => {
    // Real ids are lowercase UUIDs, where both orders agree; ids that differ
    // only in case show which comparator the twin uses. localeCompare puts
    // "a" before "B", code point (compareForOrder, like every other order of
    // this twin) puts "B" first.
    const repo = new InMemoryFuelRepository();

    for (const id of ["a-1", "B-2", "b-3", "A-4"]) {
      const fuel = await repo.createFuel(refueling());

      fuel.id = id;
    }

    const ids: string[] = [];

    for await (const row of repo.streamFuelsForExport({ businessId: A })) {
      ids.push(row.id);
    }

    expect(ids).toEqual(["A-4", "B-2", "a-1", "b-3"]);
  });
});

describe("InMemoryFuelRepository.updateFuel matches the repository", () => {
  it("clears a column sent as null and recomputes the total", async () => {
    const repo = new InMemoryFuelRepository();

    const fuel = await repo.createFuel({
      current_mileage: 1000,
      liters_amount: 10,
      price_per_liter: 5,
      notes: "Posto antigo",
      refueling_date: new Date("2026-09-01T12:00:00Z"),
      businessId: A,
      branchId: CENTRO,
      vehicleId: "v1",
      driverId: "d1",
      fuelTypeId: "diesel",
      created_from: "WEB_DASHBOARD",
    });

    const updated = await repo.updateFuel({
      fuelId: fuel.id,
      fuelData: { notes: null, price_per_liter: 6 },
    });

    expect(updated.notes).toBeNull();
    expect(updated.total_amount.toNumber()).toBe(60);
    expect(fuel.odometer_ai_status).toBe("pending");
  });
});

describe("InMemoryFuelRepository.updateFuelAndMileage matches the repository", () => {
  const TRUCK = "v-timeline";
  const day = (n: number) =>
    new Date(Date.parse("2026-09-01T12:00:00Z") + n * 86_400_000);

  async function timeline() {
    const repo = new InMemoryFuelRepository();
    repo.vehicleMileage[TRUCK] = 50_000;

    const at = async (mileage: number, when: Date) =>
      repo.createFuel({
        current_mileage: mileage,
        liters_amount: 10,
        price_per_liter: 5,
        refueling_date: when,
        businessId: A,
        branchId: CENTRO,
        vehicleId: TRUCK,
        driverId: "d1",
        fuelTypeId: "diesel",
        created_from: "WEB_DASHBOARD",
      });

    await at(40_000, day(0));
    const typo = await at(45_500, day(5));
    const last = await at(48_000, day(8));

    return { repo, typo, last };
  }

  const move = (fuelId: string, currentMileage: number, when: Date) => ({
    businessId: A,
    vehicleId: TRUCK,
    currentMileage,
    at: when,
    fuelId,
  });

  it("fits a lower reading between its neighbours, itself left out, and keeps the odometer", async () => {
    const { repo, typo } = await timeline();

    await repo.updateFuelAndMileage(
      { fuelId: typo.id, fuelData: { current_mileage: 44_500 } },
      move(typo.id, 44_500, day(5)),
    );

    expect(
      repo.fuels.find((fuel) => fuel.id === typo.id)?.current_mileage,
    ).toBe(44_500);
    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);
  });

  it("refuses a reading outside its neighbours and writes nothing", async () => {
    const { repo, typo } = await timeline();

    await expect(
      repo.updateFuelAndMileage(
        { fuelId: typo.id, fuelData: { current_mileage: 48_500 } },
        move(typo.id, 48_500, day(5)),
      ),
    ).rejects.toThrow("quilometragem");

    expect(
      repo.fuels.find((fuel) => fuel.id === typo.id)?.current_mileage,
    ).toBe(45_500);
  });

  it("refuses a past reading above the later one, even ahead of the odometer", async () => {
    // Red before: the forward rule ran first, so 51.000 on the refueling of
    // day 5 passed and moved the odometer past the one of day 8.
    const { repo, typo } = await timeline();

    await expect(
      repo.updateFuelAndMileage(
        { fuelId: typo.id, fuelData: { current_mileage: 51_000 } },
        move(typo.id, 51_000, day(5)),
      ),
    ).rejects.toThrow("quilometragem");

    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);
  });

  it("moves the odometer for the newest reading ahead of it", async () => {
    const { repo, last } = await timeline();

    await repo.updateFuelAndMileage(
      { fuelId: last.id, fuelData: { current_mileage: 51_000 } },
      move(last.id, 51_000, day(8)),
    );

    expect(repo.vehicleMileage[TRUCK]).toBe(51_000);
  });

  it("corrects the newest downwards, and the odometer it set follows", async () => {
    // Red before: with no reading after it, anything below the odometer was
    // refused, so a typo on the latest refueling froze the vehicle.
    const { repo, last } = await timeline();

    await repo.updateFuelAndMileage(
      { fuelId: last.id, fuelData: { current_mileage: 51_000 } },
      move(last.id, 51_000, day(8)),
    );
    await repo.updateFuelAndMileage(
      { fuelId: last.id, fuelData: { current_mileage: 47_000 } },
      move(last.id, 47_000, day(8)),
    );

    expect(repo.vehicleMileage[TRUCK]).toBe(47_000);

    await expect(
      repo.updateFuelAndMileage(
        { fuelId: last.id, fuelData: { current_mileage: 45_000 } },
        move(last.id, 45_000, day(8)),
      ),
    ).rejects.toThrow("quilometragem");
    expect(repo.vehicleMileage[TRUCK]).toBe(47_000);
  });

  it("corrects the newest below an odometer it did not set, and leaves it", async () => {
    const { repo, last } = await timeline();

    await repo.updateFuelAndMileage(
      { fuelId: last.id, fuelData: { current_mileage: 47_000 } },
      move(last.id, 47_000, day(8)),
    );

    expect(
      repo.fuels.find((fuel) => fuel.id === last.id)?.current_mileage,
    ).toBe(47_000);
    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);
  });
});

/**
 * The twin's odometer against the repository's (fuel-historical-edit E2E):
 * the date decides first on create and on a date-only edit, and a vehicle
 * gets back the odometer a refueling set when it corrects, moves or deletes it.
 */
describe("InMemoryFuelRepository places every write by its date", () => {
  const TRUCK = "v-timeline";
  const OTHER_TRUCK = "v-other";
  const day = (n: number) =>
    new Date(Date.parse("2026-09-01T15:00:00Z") + n * 86_400_000);

  const refuel = (mileage: number, when: Date, vehicleId = TRUCK) => ({
    current_mileage: mileage,
    liters_amount: 10,
    price_per_liter: 5,
    refueling_date: when,
    businessId: A,
    branchId: CENTRO,
    vehicleId,
    driverId: "d1",
    fuelTypeId: "diesel",
    created_from: "WEB_DASHBOARD" as const,
  });

  // 40.000 (day 0) · 45.500 (day 5) · 48.000 (day 8), odometer 50.000.
  async function timeline() {
    const repo = new InMemoryFuelRepository();
    repo.vehicleMileage[TRUCK] = 50_000;

    await repo.createFuel(refuel(40_000, day(0)));
    const middle = await repo.createFuel(refuel(45_500, day(5)));
    const last = await repo.createFuel(refuel(48_000, day(8)));

    return { repo, middle, last };
  }

  it("refuses a back-dated create above the next day's reading", async () => {
    // Red on the old twin: 510.000 on day 6 was ahead of the odometer, so it
    // passed and the odometer jumped to 510.000.
    const { repo } = await timeline();

    await expect(
      repo.createFuelWithMileage(refuel(510_000, day(6))),
    ).rejects.toThrow("quilometragem");
    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);

    const between = await repo.createFuelWithMileage(refuel(46_000, day(6)));

    expect(between.created).toBe(true);
    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);
  });

  it("lets a create pass readings of its own day, as the forward rule did", async () => {
    const { repo } = await timeline();

    // The app's reading at 15:00 of day 9, then a web refueling of day 9 at
    // local midnight: "before" that reading, on the same day.
    await repo.createFuelWithMileage(refuel(50_100, day(9)));
    await repo.createFuelWithMileage(
      refuel(50_300, new Date("2026-09-10T03:00:00Z")),
      undefined,
      { timeZone: "America/Sao_Paulo" },
    );

    expect(repo.vehicleMileage[TRUCK]).toBe(50_300);
  });

  it("checks a date-only edit at the new date", async () => {
    // The use case now sends the placement for a date-only edit (the E2E
    // fuel-historical-edit proves that); the twin places it at the new
    // date, as the repository does: 45.500 cannot go before 40.000.
    const { repo, middle } = await timeline();

    await expect(
      repo.updateFuelAndMileage(
        { fuelId: middle.id, fuelData: { refueling_date: day(-2) } },
        {
          businessId: A,
          vehicleId: TRUCK,
          currentMileage: 45_500,
          at: day(-2),
          fuelId: middle.id,
        },
      ),
    ).rejects.toThrow("quilometragem");

    expect(
      repo.fuels.find((fuel) => fuel.id === middle.id)?.refueling_date,
    ).toEqual(day(5));

    await repo.updateFuelAndMileage(
      { fuelId: middle.id, fuelData: { refueling_date: day(4) } },
      {
        businessId: A,
        vehicleId: TRUCK,
        currentMileage: 45_500,
        at: day(4),
        fuelId: middle.id,
      },
    );

    expect(
      repo.fuels.find((fuel) => fuel.id === middle.id)?.refueling_date,
    ).toEqual(day(4));
  });

  it("releases the odometer a past refueling set, corrected between later readings", async () => {
    // A 510.000 stored before this rule, which set the odometer.
    const { repo } = await timeline();
    const typo = await repo.createFuel(refuel(510_000, day(6)));
    repo.vehicleMileage[TRUCK] = 510_000;

    await repo.updateFuelAndMileage(
      { fuelId: typo.id, fuelData: { current_mileage: 46_000 } },
      {
        businessId: A,
        vehicleId: TRUCK,
        currentMileage: 46_000,
        at: day(6),
        fuelId: typo.id,
      },
    );

    expect(repo.vehicleMileage[TRUCK]).toBe(48_000);
  });

  it("gives the truck it leaves back the odometer a moved refueling set", async () => {
    const { repo } = await timeline();
    repo.vehicleMileage[OTHER_TRUCK] = 120_000;

    // Typed on TRUCK with the other truck's km, which moved TRUCK's odometer.
    const wrongTruck = await repo.createFuelWithMileage(
      refuel(121_000, day(9)),
    );
    expect(repo.vehicleMileage[TRUCK]).toBe(121_000);

    await repo.updateFuelAndMileage(
      { fuelId: wrongTruck.fuel.id, fuelData: { vehicleId: OTHER_TRUCK } },
      {
        businessId: A,
        vehicleId: OTHER_TRUCK,
        currentMileage: 121_000,
        at: day(9),
        fuelId: wrongTruck.fuel.id,
      },
    );

    expect(repo.vehicleMileage[OTHER_TRUCK]).toBe(121_000);
    expect(repo.vehicleMileage[TRUCK]).toBe(48_000);
  });

  it("takes a deleted refueling's km off the odometer it set, never below the last maintenance", async () => {
    const { repo } = await timeline();
    const typo = await repo.createFuelWithMileage(refuel(150_000, day(9)));

    await repo.deleteFuel(typo.fuel.id);

    expect(repo.vehicleMileage[TRUCK]).toBe(48_000);

    const again = await repo.createFuelWithMileage(refuel(150_000, day(9)));
    repo.vehicleMaintenanceMileage[TRUCK] = 49_000;

    await repo.deleteFuel(again.fuel.id);

    expect(repo.vehicleMileage[TRUCK]).toBe(49_000);
  });

  it("leaves an odometer the deleted refueling did not set", async () => {
    const { repo, last } = await timeline();

    await repo.deleteFuel(last.id);

    expect(repo.vehicleMileage[TRUCK]).toBe(50_000);
  });
});
