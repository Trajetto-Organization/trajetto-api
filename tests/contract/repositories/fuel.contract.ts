import { describe, expect, it } from "vitest";

import type { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import type { CreateFuelProps } from "@/modules/fuel/dtos/fuel-dto";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { expectPrismaCode, fixedId, type Kind } from "../support";

/**
 * The fuel repository's contract (decision 13.2): the list (tenant, order
 * with its tiebreakers, search over the row and its relations, literal
 * text), the per-vehicle cursor, the lookups scoped to the company, the
 * idempotency key unique per company, the previous refueling of a vehicle
 * and the guards' counts.
 */

const FUEL_FIXTURE = {
  A: fixedId("f0e1", 1),
  B: fixedId("f0e1", 2),
  branchA: fixedId("f0e2", 1),
  branchB: fixedId("f0e2", 2),
  vA1: fixedId("f0e3", 1),
  vA2: fixedId("f0e3", 2),
  vB: fixedId("f0e3", 9),
  dA1: fixedId("f0e4", 1),
  dA2: fixedId("f0e4", 2),
  dB: fixedId("f0e4", 9),
  typeA: fixedId("f0e5", 1),
  typeB: fixedId("f0e5", 2),
  missing: fixedId("f0e6", 99),
  // Plan of 02/11/2026 (C5/F3): a route of A a refuelling can be made on.
  routeA: fixedId("f0e7", 1),
  plateA1: "ABC1D23",
  plateA2: "XYZ9K87",
  plateB: "BBB1B11",
} as const;

const F = FUEL_FIXTURE;

/**
 * Seeded through createFuel, then given these created_at minutes. f3 and f4
 * share an instant (the id breaks the tie); f2 and f4 share a refueling
 * date on vA1 (the previous-refueling tie). fB reuses f1's idempotency key
 * in another company, which the per-company unique index allows.
 */
const FUEL_SEED: Array<{
  key: string;
  minute: number;
  data: CreateFuelProps;
}> = [
  {
    key: "f1",
    minute: 1,
    data: fuel(
      F.A,
      F.branchA,
      F.vA1,
      F.dA1,
      F.typeA,
      "2026-09-01T10:00:00.000Z",
      {
        notes: "tanque cheio",
        client_submission_id: "fuel-contract-1",
        current_mileage: 1100,
      },
    ),
  },
  {
    key: "f2",
    minute: 2,
    data: fuel(
      F.A,
      F.branchA,
      F.vA1,
      F.dA2,
      F.typeA,
      "2026-09-02T10:00:00.000Z",
      {
        notes: "desconto 10%",
        current_mileage: 1200,
      },
    ),
  },
  {
    key: "f3",
    minute: 3,
    data: fuel(
      F.A,
      F.branchA,
      F.vA2,
      F.dA1,
      F.typeA,
      "2026-09-02T10:00:00.000Z",
      {
        current_mileage: 2100,
      },
    ),
  },
  {
    key: "f4",
    minute: 3,
    data: fuel(
      F.A,
      F.branchA,
      F.vA1,
      F.dA1,
      F.typeA,
      "2026-09-02T10:00:00.000Z",
      {
        current_mileage: 1250,
      },
    ),
  },
  {
    key: "fB",
    minute: 4,
    data: fuel(
      F.B,
      F.branchB,
      F.vB,
      F.dB,
      F.typeB,
      "2026-09-01T10:00:00.000Z",
      {
        client_submission_id: "fuel-contract-1",
        current_mileage: 500,
      },
    ),
  },
];

function fuel(
  businessId: string,
  branchId: string,
  vehicleId: string,
  driverId: string,
  fuelTypeId: string,
  refuelingDate: string,
  extra: Partial<CreateFuelProps> = {},
): CreateFuelProps {
  return {
    businessId,
    branchId,
    vehicleId,
    driverId,
    fuelTypeId,
    refueling_date: new Date(refuelingDate),
    current_mileage: 1000,
    liters_amount: "100.000",
    price_per_liter: "6.000",
    odometer_photo: `uploads/${businessId}/odometer.jpg`,
    created_from: "WEB_DASHBOARD",
    ...extra,
  };
}

interface FuelHarness {
  kind: Kind;
  repo: IFuelRepository;
  /** The id each seed row got, by key. */
  id(key: string): string;
}

function fuelRepositoryContract(harness: () => FuelHarness): void {
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  /** The tie f3/f4 in `id desc`, the order the tiebreaker promises. */
  const tie = (h: FuelHarness) => [h.id("f3"), h.id("f4")].sort().reverse();

  describe("streamFuelsForExport", () => {
    // The export reads in batches keyed by (created_at, id), the delivery
    // export's keyset (export-keyset.ts): oldest first, the id breaking a
    // tie, never another company's rows.
    it("exports one company in creation order, the id breaking a created_at tie", async () => {
      const h = harness();
      const exported: Array<{ id: string }> = [];

      for await (const row of h.repo.streamFuelsForExport({
        businessId: F.A,
      })) {
        exported.push(row);
      }

      expect(ids(exported)).toEqual([
        h.id("f1"),
        h.id("f2"),
        ...tie(h).reverse(),
      ]);
    });
  });

  describe("listFuels", () => {
    it("lists one company newest first, the id breaking a created_at tie, and pages", async () => {
      const h = harness();

      const all = await h.repo.listFuels({
        businessId: F.A,
        page: 1,
        pageSize: 10,
      });

      expect(ids(all.data)).toEqual([...tie(h), h.id("f2"), h.id("f1")]);

      const second = await h.repo.listFuels({
        businessId: F.A,
        page: 2,
        pageSize: 2,
      });

      expect(ids(second.data)).toEqual([h.id("f2"), h.id("f1")]);
    });

    it("sorts by a relation in code-point order, ties newest first", async () => {
      const h = harness();

      const byDriver = await h.repo.listFuels({
        businessId: F.A,
        page: 1,
        pageSize: 10,
        sort: "driver_name",
        order: "asc",
      });

      // "Marcos Prado" < "joão" by code point; Marcos' ties newest first.
      expect(ids(byDriver.data)).toEqual([...tie(h), h.id("f1"), h.id("f2")]);
    });

    it("searches the plate, the driver, and the notes literally and case-insensitively", async () => {
      const h = harness();
      const search = async (term: string) =>
        ids(
          (
            await h.repo.listFuels({
              businessId: F.A,
              search: term,
              page: 1,
              pageSize: 10,
            })
          ).data,
        );

      expect(await search("abc1d")).toEqual([
        h.id("f4"),
        h.id("f2"),
        h.id("f1"),
      ]);
      expect(await search("MARCOS")).toEqual([...tie(h), h.id("f1")]);
      expect(await search("10%")).toEqual([h.id("f2")]);
      expect(await search("_")).toEqual([]);
      // The plate of another company's vehicle finds nothing here.
      expect(await search(F.plateB)).toEqual([]);
    });

    it("keeps a driver to his own refuelings and filters by vehicle", async () => {
      const h = harness();

      expect(
        ids(
          (
            await h.repo.listFuels({
              businessId: F.A,
              driverId: F.dA2,
              page: 1,
              pageSize: 10,
            })
          ).data,
        ),
      ).toEqual([h.id("f2")]);
      expect(
        ids(
          (
            await h.repo.listFuels({
              businessId: F.A,
              vehicleIds: [F.vA2],
              page: 1,
              pageSize: 10,
            })
          ).data,
        ),
      ).toEqual([h.id("f3")]);
    });

    it("groups the base for the cards and names only the company's catalog", async () => {
      const h = harness();

      const result = await h.repo.listFuels({
        businessId: F.A,
        page: 1,
        pageSize: 1,
      });
      const count = result.groups.reduce((sum, group) => sum + group.count, 0);

      expect(count).toBe(4);
      expect(result.labels.vehicleId).toEqual({
        [F.vA1]: F.plateA1,
        [F.vA2]: F.plateA2,
      });
    });
  });

  describe("lookups", () => {
    it("answer another company's refueling with null", async () => {
      const h = harness();

      expect(
        (
          await h.repo.getFuelByIdAndBusiness({
            businessId: F.A,
            fuelId: h.id("f1"),
          })
        )?.id,
      ).toBe(h.id("f1"));
      expect(
        await h.repo.getFuelByIdAndBusiness({
          businessId: F.B,
          fuelId: h.id("f1"),
        }),
      ).toBeNull();
      expect(await h.repo.findFuelById(F.missing)).toBeNull();
    });

    it("find an idempotency key only in its company", async () => {
      const h = harness();

      expect(
        (await h.repo.findBySubmissionId(F.A, "fuel-contract-1"))?.id,
      ).toBe(h.id("f1"));
      expect(
        (await h.repo.findBySubmissionId(F.B, "fuel-contract-1"))?.id,
      ).toBe(h.id("fB"));
      expect(await h.repo.findBySubmissionId(F.A, "never-sent")).toBeNull();
    });

    it("count what the deletion guards ask", async () => {
      const h = harness();

      expect(await h.repo.countFuelsByVehicleId(F.vA1)).toBe(3);
      expect(await h.repo.countFuelsByDriverId(F.dA1)).toBe(3);
      expect(await h.repo.countFuelsByVehicleId(F.missing)).toBe(0);
    });

    it("find the previous refueling by date, the later record winning a same-date tie", async () => {
      const h = harness();

      expect(
        (
          await h.repo.getPreviousFuelByVehicleId(
            F.vA1,
            "2026-09-03T00:00:00.000Z",
            F.A,
          )
        )?.id,
      ).toBe(h.id("f4"));
      expect(
        (
          await h.repo.getPreviousFuelByVehicleId(
            F.vA1,
            "2026-09-02T10:00:00.000Z",
            F.A,
          )
        )?.id,
      ).toBe(h.id("f1"));
      expect(
        await h.repo.getPreviousFuelByVehicleId(
          F.vA1,
          "2026-09-01T10:00:00.000Z",
          F.A,
        ),
      ).toBeNull();
    });

    it("never reads another company's refueling, even by the vehicle's id", async () => {
      // Scoped in the repository too: the callers check the vehicle first,
      // but an unscoped read is one forgotten check away from a leak.
      const h = harness();

      expect(
        await h.repo.getPreviousFuelByVehicleId(
          F.vA1,
          "2026-09-03T00:00:00.000Z",
          F.B,
        ),
      ).toBeNull();
    });
  });

  describe("searchFuelByVehicleWithCursor", () => {
    it("walks one vehicle of the company newest first without repeating or skipping", async () => {
      const h = harness();
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let step = 0; step < 5; step += 1) {
        const page = await h.repo.searchFuelByVehicleWithCursor({
          vehicleId: F.vA1,
          businessId: F.A,
          limit: 1,
          cursor,
        });

        seen.push(...ids(page.data));
        if (!page.hasMore) break;
        cursor = page.nextCursor ?? undefined;
      }

      expect(seen).toEqual([h.id("f4"), h.id("f2"), h.id("f1")]);
    });

    it("answers nothing for another company's vehicle or a cursor that does not exist", async () => {
      const h = harness();

      expect(
        (
          await h.repo.searchFuelByVehicleWithCursor({
            vehicleId: F.vB,
            businessId: F.A,
            limit: 10,
          })
        ).data,
      ).toEqual([]);
      expect(
        (
          await h.repo.searchFuelByVehicleWithCursor({
            vehicleId: F.vA1,
            businessId: F.A,
            cursor: F.missing,
            limit: 10,
          })
        ).data,
      ).toEqual([]);
    });
  });

  // Writes last: they add rows the reads above would count.
  describe("createFuel", () => {
    it("refuses the same idempotency key twice in a company (P2002)", async () => {
      const h = harness();

      await expectPrismaCode(
        h.repo.createFuel(
          fuel(
            F.A,
            F.branchA,
            F.vA2,
            F.dA2,
            F.typeA,
            "2026-09-05T10:00:00.000Z",
            {
              client_submission_id: "fuel-contract-1",
            },
          ),
        ),
        "P2002",
      );
    });

    it("stores the values as sent: an empty note stays empty, a zero coordinate stays zero", async () => {
      const h = harness();

      const created = await h.repo.createFuel(
        fuel(
          F.A,
          F.branchA,
          F.vA2,
          F.dA2,
          F.typeA,
          "2026-09-05T10:00:00.000Z",
          {
            notes: "",
            latitude: 0,
            longitude: 0,
          },
        ),
      );

      expect(created).toMatchObject({ notes: "", latitude: 0, longitude: 0 });
      expect(created.total_amount.toString()).toBe("600");
    });

    // Plan of 02/11/2026 (C5/F3): the route it was made on, or null outside
    // one (every legacy refuelling).
    it("stores the route a refuelling was made on, and null without one", async () => {
      const h = harness();
      const at = "2026-09-05T11:00:00.000Z";

      const onRoute = await h.repo.createFuel(
        fuel(F.A, F.branchA, F.vA2, F.dA2, F.typeA, at, {
          routeId: F.routeA,
        }),
      );
      const loose = await h.repo.createFuel(
        fuel(F.A, F.branchA, F.vA2, F.dA2, F.typeA, at),
      );

      expect(onRoute.routeId).toBe(F.routeA);
      expect(loose.routeId).toBeNull();
    });
  });

  // Plan of 02/11/2026 (F3, read side): the route detail lists the
  // refuellings made on the route, in date order, inside the company — a
  // row of another company naming the route never shows.
  describe("listRouteFuels", () => {
    it("lists a route's refuellings of the company, oldest first, as numbers", async () => {
      const h = harness();

      const later = await h.repo.createFuel(
        fuel(
          F.A,
          F.branchA,
          F.vA2,
          F.dA2,
          F.typeA,
          "2026-09-06T15:00:00.000Z",
          {
            routeId: F.routeA,
            liters_amount: 40,
            price_per_liter: 6.5,
            total_amount: 260,
            current_mileage: 5_000,
          },
        ),
      );
      const earlier = await h.repo.createFuel(
        fuel(
          F.A,
          F.branchA,
          F.vA2,
          F.dA2,
          F.typeA,
          "2026-09-06T09:00:00.000Z",
          {
            routeId: F.routeA,
          },
        ),
      );
      const foreign = await h.repo.createFuel(
        fuel(F.B, F.branchB, F.vB, F.dB, F.typeB, "2026-09-06T10:00:00.000Z", {
          routeId: F.routeA,
        }),
      );

      const listed = await h.repo.listRouteFuels(F.A, F.routeA);
      const ids = listed.map((row) => row.id);

      expect(ids).toContain(later.id);
      expect(ids).toContain(earlier.id);
      expect(ids).not.toContain(foreign.id);
      expect(ids.indexOf(earlier.id)).toBeLessThan(ids.indexOf(later.id));

      expect(listed.find((row) => row.id === later.id)).toEqual({
        id: later.id,
        refueling_date: new Date("2026-09-06T15:00:00.000Z"),
        liters_amount: 40,
        price_per_liter: 6.5,
        total_amount: 260,
        current_mileage: 5_000,
        vehicleId: F.vA2,
        driverId: F.dA2,
        odometer_ai_status: expect.any(String),
        // 05/11/2026: none on a plain insert.
        alerts: [],
        recent_refuel_reason: null,
        recent_refuel_previous_at: null,
      });

      expect(await h.repo.listRouteFuels(F.A, F.missing)).toEqual([]);
    });
  });

  // Contract C3 (03/11/2026): the list and the vehicle's history name the
  // route each refuelling was made on — its id and code, the code as text —
  // and only a route of the row's own company; another company's route
  // (a row naming it) reads as no route.
  describe("the route columns of the list and the vehicle history", () => {
    it("name the company's route, and nothing for a loose refuelling or another company's route", async () => {
      const h = harness();
      const at = "2026-09-07T11:00:00.000Z";

      const onRoute = await h.repo.createFuel(
        fuel(F.A, F.branchA, F.vA2, F.dA2, F.typeA, at, { routeId: F.routeA }),
      );
      const loose = await h.repo.createFuel(
        fuel(F.A, F.branchA, F.vA2, F.dA2, F.typeA, at),
      );
      const foreign = await h.repo.createFuel(
        fuel(F.B, F.branchB, F.vB, F.dB, F.typeB, at, { routeId: F.routeA }),
      );

      const routeOf = (rows: Array<Record<string, unknown>>, id: string) => {
        const row = rows.find((entry) => entry.id === id);

        return row && { routeId: row.routeId, route: row.route };
      };

      const listed = (
        await h.repo.listFuels({ businessId: F.A, page: 1, pageSize: 100 })
      ).data as unknown as Array<Record<string, unknown>>;

      expect(routeOf(listed, onRoute.id)).toEqual({
        routeId: F.routeA,
        route: { id: F.routeA, code: "1" },
      });
      expect(routeOf(listed, loose.id)).toEqual({ routeId: null, route: null });

      const theirs = (
        await h.repo.listFuels({ businessId: F.B, page: 1, pageSize: 100 })
      ).data as unknown as Array<Record<string, unknown>>;

      expect(routeOf(theirs, foreign.id)).toEqual({
        routeId: F.routeA,
        route: null,
      });

      const history = (
        await h.repo.searchFuelByVehicleWithCursor({
          businessId: F.A,
          vehicleId: F.vA2,
          limit: 100,
        })
      ).data as unknown as Array<Record<string, unknown>>;

      expect(routeOf(history, onRoute.id)).toEqual({
        routeId: F.routeA,
        route: { id: F.routeA, code: "1" },
      });
      expect(routeOf(history, loose.id)).toEqual({
        routeId: null,
        route: null,
      });
    });
  });

  // 05/11/2026 (20261105130000): another refuelling of the vehicle within 30
  // minutes, either side, flags the new one inside the create's transaction;
  // an edit that moves the date measures it again and keeps the reason; the
  // list filters and groups by it. Last in the file: the dates (October) sit
  // after every other row of vB, so each write is the vehicle's newest.
  describe("the recent-refuel alert", () => {
    const ZONE = { timeZone: "America/Sao_Paulo" };
    const FIRST = "2026-10-01T13:00:00.000Z";
    const SECOND = "2026-10-01T13:15:00.000Z";

    it("reads the vehicle's refuellings inside the window, open at both ends, in the company", async () => {
      const h = harness();

      // f2 and f4 are vA1's at 2026-09-02T10:00.
      const near = await h.repo.findRefuelsNear(
        F.A,
        F.vA1,
        new Date("2026-09-02T10:20:00.000Z"),
      );

      expect(near.map((row) => row.id)).toEqual(
        [h.id("f2"), h.id("f4")].sort(),
      );
      expect(near[0]).toMatchObject({
        refueling_date: new Date("2026-09-02T10:00:00.000Z"),
        current_mileage: expect.any(Number),
      });

      // Exactly 30 minutes away is out.
      expect(
        await h.repo.findRefuelsNear(
          F.A,
          F.vA1,
          new Date("2026-09-02T10:30:00.000Z"),
        ),
      ).toEqual([]);
      // Another company's vehicle, by id, reads nothing here.
      expect(
        await h.repo.findRefuelsNear(
          F.A,
          F.vB,
          new Date("2026-09-01T10:00:00.000Z"),
        ),
      ).toEqual([]);
    });

    it("flags a create 15 minutes after another, with the reason; edits measure again", async () => {
      const h = harness();

      const first = await h.repo.createFuelWithMileage(
        fuel(F.B, F.branchB, F.vB, F.dB, F.typeB, FIRST, {
          current_mileage: 5_000,
        }),
        undefined,
        ZONE,
      );

      expect(first.fuel).toMatchObject({
        alerts: [],
        recent_refuel_previous_at: null,
        recent_refuel_reason: null,
      });

      const second = await h.repo.createFuelWithMileage(
        fuel(F.B, F.branchB, F.vB, F.dB, F.typeB, SECOND, {
          current_mileage: 5_100,
        }),
        undefined,
        { ...ZONE, recentRefuelReason: "Tanque na reserva" },
      );

      expect(second.created).toBe(true);
      expect(second.fuel).toMatchObject({
        alerts: ["RECENT_REFUEL"],
        recent_refuel_previous_at: new Date(FIRST),
        recent_refuel_reason: "Tanque na reserva",
      });

      // The office moves it two hours later: no longer recent, reason kept.
      const later = new Date("2026-10-01T15:15:00.000Z");
      const moved = await h.repo.updateFuelAndMileage(
        { fuelId: second.fuel.id, fuelData: { refueling_date: later } },
        {
          ...ZONE,
          businessId: F.B,
          vehicleId: F.vB,
          currentMileage: 5_100,
          at: later,
          fuelId: second.fuel.id,
        },
      );

      expect(moved).toMatchObject({
        alerts: [],
        recent_refuel_previous_at: null,
        recent_refuel_reason: "Tanque na reserva",
      });

      // The list filters by it and groups the base by it.
      const back = new Date(SECOND);

      await h.repo.updateFuelAndMileage(
        { fuelId: second.fuel.id, fuelData: { refueling_date: back } },
        {
          ...ZONE,
          businessId: F.B,
          vehicleId: F.vB,
          currentMileage: 5_100,
          at: back,
          fuelId: second.fuel.id,
        },
      );

      const flagged = await h.repo.listFuels({
        businessId: F.B,
        page: 1,
        pageSize: 100,
        alerts: ["RECENT_REFUEL"],
      });

      expect(ids(flagged.data)).toEqual([second.fuel.id]);
      expect(flagged.data[0]).toMatchObject({
        alerts: ["RECENT_REFUEL"],
        recent_refuel_previous_at: new Date(FIRST),
        recent_refuel_reason: "Tanque na reserva",
      });
      expect(
        flagged.groups
          .filter((group) => group.alerts.includes("RECENT_REFUEL"))
          .reduce((sum, group) => sum + group.count, 0),
      ).toBe(1);
      expect(
        await h.repo.countFuelForExport({
          businessId: F.B,
          alerts: ["RECENT_REFUEL"],
        }),
      ).toBe(1);
    });
  });

  // 05/11/2026: the odometer stands still for a short while. A refuelling
  // may read the km of the record before it when that record is less than 30
  // minutes away (fuel-rules.ts placeReading, over the timeline reads that
  // bring each reading's record); 30 minutes or more apart, the strict rule.
  // After the recent-refuel alert, on the next day: each write is vB's
  // newest, and the twin's odometer is seeded like Postgres' (1 000 km).
  describe("the odometer standing still", () => {
    const ZONE = { timeZone: "America/Sao_Paulo" };
    const STOP = "2026-10-02T13:00:00.000Z";

    it("stores a refuelling at the km of one 10 minutes before, and refuses it 35 minutes after the last", async () => {
      const h = harness();
      const at = (iso: string) =>
        h.repo.createFuelWithMileage(
          fuel(F.B, F.branchB, F.vB, F.dB, F.typeB, iso, {
            current_mileage: 5_200,
          }),
          undefined,
          ZONE,
        );

      expect((await at(STOP)).created).toBe(true);

      const second = await at("2026-10-02T13:10:00.000Z");

      expect(second.created).toBe(true);
      expect(second.fuel).toMatchObject({
        current_mileage: 5_200,
        alerts: ["RECENT_REFUEL"],
        recent_refuel_previous_at: new Date(STOP),
      });

      await expect(at("2026-10-02T13:45:00.000Z")).rejects.toBeInstanceOf(
        VehicleMileageInvalidError,
      );
    });
  });
}

export { FUEL_FIXTURE, FUEL_SEED, fuelRepositoryContract };
export type { FuelHarness };
