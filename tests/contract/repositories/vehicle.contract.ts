import { describe, expect, it } from "vitest";

import type { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import type { CreateVehicleProps } from "@/modules/vehicle/dtos/vehicle-dto";

import { expectPrismaCode, fixedId, minute, type Kind } from "../support";

/**
 * The vehicle repository's contract (decision 13.2): the Veículos list
 * (order, enum sort, relation sort, search, facets), the plate/RENAVAM
 * uniqueness the create relies on, the case-insensitive lookups, and the
 * picker's cursor.
 */

const A = fixedId("0fea", 1);
const B = fixedId("0fea", 2);

const VEHICLE_FIXTURE = {
  A,
  B,
  fuelTypeA: fixedId("0ff7", 1),
  fuelTypeB: fixedId("0ff7", 2),
  vehicleTypeA: fixedId("0ff8", 1),
  driverA: fixedId("0ff9", 1),
  branchA: fixedId("0ffa", 1),
  vehicleTypeName: "Truck Baú",
  driverName: "Zeca Pagodinho",
  branchName: "Filial Centro",
} as const;

const F = VEHICLE_FIXTURE;

const base = (
  n: number,
  extra: Partial<CreateVehicleProps>,
): CreateVehicleProps => ({
  description: `Caminhão ${n}`,
  license_plate: `AAA${n}B${n}${n}`,
  brand: "Volvo",
  model: "FH",
  acquisition_date: new Date("2024-01-10T00:00:00.000Z"),
  fleet_type: "OWNED",
  current_mileage: 1000 * n,
  maintenance_interval_km: 10000,
  maintenance_interval_months: 6,
  renavam: `0000000000${n}`,
  manufacturing_year: new Date("2023-01-01T00:00:00.000Z"),
  model_year: new Date("2024-01-01T00:00:00.000Z"),
  km_per_liter: 3,
  number_of_axles: 3,
  status: "ACTIVE",
  businessId: A,
  fuelTypeId: F.fuelTypeA,
  ...extra,
});

/** Created in this order; minute = created_at. v4/v5 share an instant. */
const VEHICLE_SEED: Array<{
  key: string;
  minute: number;
  data: CreateVehicleProps;
}> = [
  {
    key: "v1",
    minute: 1,
    data: base(1, {
      status: "IN_ROUTE",
      driverId: F.driverA,
      vehicleTypeId: F.vehicleTypeA,
      branchId: F.branchA,
      last_maintenance_mileage: 0,
    }),
  },
  {
    key: "v2",
    minute: 2,
    data: base(2, { status: "BLOCKED", brand: "Scania" }),
  },
  {
    key: "v3",
    minute: 3,
    data: base(3, { status: "INACTIVE", description: "Utilitário 50%" }),
  },
  {
    key: "v4",
    minute: 4,
    data: base(4, { status: "ACTIVE", fleet_id: "FROTA-9" }),
  },
  {
    key: "v5",
    minute: 4,
    data: base(5, { status: "ACTIVE", driverId: F.driverA }),
  },
  // Another company, same plate and RENAVAM as v1: allowed.
  {
    key: "b1",
    minute: 0,
    data: base(1, {
      businessId: B,
      fuelTypeId: F.fuelTypeB,
      description: "Caminhão de B",
    }),
  },
];

interface VehicleHarness {
  kind: Kind;
  repo: IVehicleRepository;
  id(key: string): string;
}

async function seedVehicles(
  repo: IVehicleRepository,
  pin: (id: string, at: Date) => Promise<void>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const row of [...VEHICLE_SEED].reverse()) {
    const created = await repo.createVehicle(row.data);
    ids.set(row.key, created.id);
    await pin(created.id, minute(row.minute));
  }

  return ids;
}

function vehicleRepositoryContract(harness: () => VehicleHarness): void {
  const list = (
    extra: Partial<Parameters<IVehicleRepository["listVehicles"]>[0]> = {},
  ) =>
    harness().repo.listVehicles({
      page: 1,
      pageSize: 50,
      businessId: A,
      ...extra,
    });
  const idsOf = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  const tie = (h: VehicleHarness, order: "asc" | "desc") => {
    const pair = [h.id("v4"), h.id("v5")].sort();
    return order === "desc" ? pair.reverse() : pair;
  };

  describe("listVehicles", () => {
    it("lists one company newest first, the id breaking a created_at tie, and pages", async () => {
      const h = harness();
      const pages = await Promise.all(
        [1, 2, 3].map((page) => list({ page, pageSize: 2 })),
      );

      expect(pages.flatMap((page) => idsOf(page.data))).toEqual([
        ...tie(h, "desc"),
        h.id("v3"),
        h.id("v2"),
        h.id("v1"),
      ]);
    });

    it("sorts the status by the enum's declaration order, not alphabetically", async () => {
      const h = harness();

      expect(
        idsOf((await list({ sort: "status", order: "asc" })).data),
      ).toEqual([...tie(h, "desc"), h.id("v3"), h.id("v2"), h.id("v1")]);
    });

    it("sorts by driver with the vehicles without one last ascending and first descending", async () => {
      const h = harness();
      const withDriver = [h.id("v5"), h.id("v1")];
      const without = [h.id("v4"), h.id("v3"), h.id("v2")];

      expect(
        idsOf((await list({ sort: "driverName", order: "asc" })).data),
      ).toEqual([...withDriver, ...without]);
      expect(
        idsOf((await list({ sort: "driverName", order: "desc" })).data),
      ).toEqual([...without, ...withDriver]);
    });

    it("searches plate, brand, fleet id, driver, type and branch case-insensitively, literally, and the id exactly", async () => {
      const h = harness();
      const found = async (search: string) =>
        idsOf((await list({ search })).data).sort();

      expect(await found("aaa2b")).toEqual([h.id("v2")]);
      expect(await found("SCANIA")).toEqual([h.id("v2")]);
      expect(await found("frota-9")).toEqual([h.id("v4")]);
      expect(await found("zeca")).toEqual([h.id("v1"), h.id("v5")].sort());
      expect(await found("baú")).toEqual([h.id("v1")]);
      expect(await found("filial")).toEqual([h.id("v1")]);
      expect(await found("50%")).toEqual([h.id("v3")]);
      expect(await found(h.id("v4"))).toEqual([h.id("v4")]);
      expect(await found(h.id("b1"))).toEqual([]);
    });

    it("counts the statuses over every filter but status, and branches within the company", async () => {
      const page = await list({ statuses: ["ACTIVE"] });

      expect(page.data).toHaveLength(2);
      expect(page.statusCounts).toEqual({
        ACTIVE: 2,
        INACTIVE: 1,
        BLOCKED: 1,
        IN_ROUTE: 1,
      });
      expect(page.branchCounts).toEqual([]);

      const all = await list();
      expect(all.branchCounts).toEqual([
        { id: F.branchA, name: F.branchName, count: 1 },
      ]);
    });
  });

  describe("create and lookups", () => {
    it("keeps a 0 km last-maintenance reading as 0, not NULL", async () => {
      const h = harness();

      expect(
        (await h.repo.findVehicleById(h.id("v1")))?.last_maintenance_mileage,
      ).toBe(0);
      expect(
        (await h.repo.findVehicleById(h.id("v2")))?.last_maintenance_mileage,
      ).toBeNull();
    });

    it("refuses a plate or RENAVAM already used in the company (P2002), on create and update", async () => {
      const h = harness();

      await expectPrismaCode(
        h.repo.createVehicle(base(9, { license_plate: "AAA2B22" })),
        "P2002",
      );
      await expectPrismaCode(
        h.repo.createVehicle(base(9, { renavam: "00000000003" })),
        "P2002",
      );
      await expectPrismaCode(
        h.repo.updateVehicle({
          vehicleId: h.id("v4"),
          vehicleData: { license_plate: "AAA5B55" },
        }),
        "P2002",
      );
    });

    it("finds a plate and a RENAVAM whatever the case, inside the company only", async () => {
      const h = harness();

      expect((await h.repo.findVehicleByLicensePlate("aaa1b11", A))?.id).toBe(
        h.id("v1"),
      );
      expect((await h.repo.findVehicleByLicensePlate("AAA1B11", B))?.id).toBe(
        h.id("b1"),
      );
      expect(await h.repo.findVehicleByLicensePlate("AAA2B22", B)).toBeNull();
      expect((await h.repo.findVehicleByRenavam("00000000002", A))?.id).toBe(
        h.id("v2"),
      );
    });
  });

  describe("searchVehicleWithCursor", () => {
    it("offers the active and in-route vehicles, newest first, and walks the cursor", async () => {
      const h = harness();
      const first = await h.repo.searchVehicleWithCursor({
        limit: 2,
        businessId: A,
      });

      expect(idsOf(first.data)).toEqual(tie(h, "desc"));
      expect(first.hasMore).toBe(true);

      const second = await h.repo.searchVehicleWithCursor({
        limit: 2,
        businessId: A,
        cursor: first.nextCursor!,
      });

      expect(idsOf(second.data)).toEqual([h.id("v1")]);
      expect(second.hasMore).toBe(false);
    });

    it("answers a cursor the list cannot continue from with nothing", async () => {
      const h = harness();
      const page = (cursor: string) =>
        h.repo.searchVehicleWithCursor({ limit: 10, businessId: A, cursor });

      expect((await page(fixedId("0fea", 99))).data).toEqual([]);
      // v2 is BLOCKED (outside the `where`): Prisma still positions on it,
      // and skip: 1 drops the first row after it (v1).
      expect((await page(h.id("v2"))).data).toEqual([]);
    });
  });
}

export {
  VEHICLE_FIXTURE,
  VEHICLE_SEED,
  seedVehicles,
  vehicleRepositoryContract,
};
export type { VehicleHarness };
