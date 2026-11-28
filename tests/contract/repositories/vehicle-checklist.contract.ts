import { describe, expect, it } from "vitest";

import type { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { fixedId, minute, type Kind } from "../support";

/**
 * The vehicle checklist repository's contract, starting with its route
 * checklists read (plan of 02/11/2026, C4): what the driver's payload derives
 * "checklist de saída / chegada feito?" from. Only the departure and arrival checklists of the
 * routes asked for, newest first, never a STANDALONE one and never another
 * company's row — even one naming the same route id.
 */

const ROUTE_CHECKLIST_FIXTURE = {
  A: fixedId("0c4a", 1),
  B: fixedId("0c4a", 2),
  branchA: fixedId("0c4b", 1),
  branchB: fixedId("0c4b", 2),
  driverA: fixedId("0c4d", 1),
  driverB: fixedId("0c4d", 2),
  vehicleA: fixedId("0c4e", 1),
  vehicleB: fixedId("0c4e", 2),
  route1: fixedId("0c4f", 1),
  route2: fixedId("0c4f", 2),
  routeUnasked: fixedId("0c4f", 3),
  routeDoneLongAgo: fixedId("0c4f", 4),
  routeCancelled: fixedId("0c4f", 5),
  routeB: fixedId("0c4f", 6),
} as const;

const F = ROUTE_CHECKLIST_FIXTURE;

type Phase = "STANDALONE" | "ROUTE_START" | "ROUTE_END";

interface RouteChecklistSeed {
  id: string;
  businessId: string;
  routeId: string | null;
  phase: Phase;
  checklist_date: Date;
  overall_condition: string;
}

/** The rows both sides are seeded with. */
const ROUTE_CHECKLIST_SEED: RouteChecklistSeed[] = [
  {
    id: fixedId("0c40", 1),
    businessId: F.A,
    routeId: F.route1,
    phase: "ROUTE_START",
    checklist_date: minute(0),
    overall_condition: "rejected",
  },
  {
    id: fixedId("0c40", 2),
    businessId: F.A,
    routeId: F.route1,
    phase: "ROUTE_START",
    checklist_date: minute(30),
    overall_condition: "approved",
  },
  // Made outside the route, though it names it: never the route's.
  {
    id: fixedId("0c40", 3),
    businessId: F.A,
    routeId: F.route1,
    phase: "STANDALONE",
    checklist_date: minute(60),
    overall_condition: "approved",
  },
  {
    id: fixedId("0c40", 4),
    businessId: F.A,
    routeId: F.route2,
    phase: "ROUTE_END",
    checklist_date: minute(90),
    overall_condition: "approved_with_restrictions",
  },
  // A route nobody asked for.
  {
    id: fixedId("0c40", 5),
    businessId: F.A,
    routeId: F.routeUnasked,
    phase: "ROUTE_START",
    checklist_date: minute(120),
    overall_condition: "approved",
  },
  // Another company's row naming company A's route id.
  {
    id: fixedId("0c40", 6),
    businessId: F.B,
    routeId: F.route1,
    phase: "ROUTE_END",
    checklist_date: minute(150),
    overall_condition: "rejected",
  },
];

/**
 * The routes both sides know, for the "still owes its arrival checklist"
 * read (the wave-1 C4 follow-up): route1 ended recently with only departure
 * checklists of its own company (another company's row naming it must not
 * count), route2 ended with its arrival checklist, routeUnasked is still
 * running, one ended before the window, one was cancelled, and one is
 * another company's.
 */
interface RouteSeed {
  id: string;
  businessId: string;
  driverId: string;
  vehicle: { id: string; license_plate: string } | null;
  code: number;
  plan_version: number;
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  completed_at: Date | null;
}

const ROUTE_SEED: RouteSeed[] = [
  {
    id: F.route1,
    businessId: F.A,
    driverId: F.driverA,
    vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
    code: 1,
    plan_version: 3,
    status: "COMPLETED",
    completed_at: minute(200),
  },
  {
    id: F.route2,
    businessId: F.A,
    driverId: F.driverA,
    vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
    code: 2,
    plan_version: 1,
    status: "COMPLETED",
    completed_at: minute(210),
  },
  {
    id: F.routeUnasked,
    businessId: F.A,
    driverId: F.driverA,
    vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
    code: 3,
    plan_version: 0,
    status: "IN_PROGRESS",
    completed_at: null,
  },
  {
    id: F.routeDoneLongAgo,
    businessId: F.A,
    driverId: F.driverA,
    vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
    code: 4,
    plan_version: 0,
    status: "COMPLETED",
    completed_at: minute(10),
  },
  {
    id: F.routeCancelled,
    businessId: F.A,
    driverId: F.driverA,
    vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
    code: 5,
    plan_version: 0,
    status: "CANCELLED",
    completed_at: null,
  },
  {
    id: F.routeB,
    businessId: F.B,
    driverId: F.driverB,
    vehicle: { id: F.vehicleB, license_plate: "CHK2B22" },
    code: 1,
    plan_version: 0,
    status: "COMPLETED",
    completed_at: minute(200),
  },
];

interface RouteChecklistHarness {
  kind: Kind;
  repo: IVehicleChecklistRepository;
}

function routeChecklistContract(harness: () => RouteChecklistHarness): void {
  describe("listRouteChecklists", () => {
    it("reads the departure and arrival checklists of the routes asked for, newest first", async () => {
      const rows = await harness().repo.listRouteChecklists(F.A, [
        F.route1,
        F.route2,
      ]);

      expect(rows.map((row) => [row.id, row.routeId, row.phase])).toEqual([
        [fixedId("0c40", 4), F.route2, "ROUTE_END"],
        [fixedId("0c40", 2), F.route1, "ROUTE_START"],
        [fixedId("0c40", 1), F.route1, "ROUTE_START"],
      ]);
      expect(rows[0]).toEqual({
        id: fixedId("0c40", 4),
        routeId: F.route2,
        phase: "ROUTE_END",
        checklist_date: minute(90),
        overall_condition: "approved_with_restrictions",
      });
    });

    it("never reads another company's row, even one naming the same route", async () => {
      const rows = await harness().repo.listRouteChecklists(F.B, [F.route1]);

      expect(rows.map((row) => row.id)).toEqual([fixedId("0c40", 6)]);
      expect(
        (await harness().repo.listRouteChecklists(F.A, [F.route1])).map(
          (row) => row.id,
        ),
      ).not.toContain(fixedId("0c40", 6));
    });

    it("answers nothing for no route", async () => {
      expect(await harness().repo.listRouteChecklists(F.A, [])).toEqual([]);
    });
  });

  // Contract C3 (03/11/2026): the list names each checklist's route (id and
  // code, the code as text) only when the route is the row's own company's,
  // and its moment only when it was made for the route.
  describe("the route columns of the list", () => {
    const columnsOf = async (businessId: string) =>
      Object.fromEntries(
        (
          await harness().repo.listVehicleChecklists({
            businessId,
            page: 1,
            pageSize: 100,
          })
        ).data.map((row) => {
          const listed = row as unknown as Record<string, unknown>;

          return [
            listed.id,
            {
              routeId: listed.routeId,
              route: listed.route,
              phase: listed.phase,
            },
          ];
        }),
      );

    it("names the company's route and the moment, and null for a checklist outside one", async () => {
      const columns = await columnsOf(F.A);

      expect(columns[fixedId("0c40", 1)]).toEqual({
        routeId: F.route1,
        route: { id: F.route1, code: "1" },
        phase: "ROUTE_START",
      });
      expect(columns[fixedId("0c40", 4)]).toEqual({
        routeId: F.route2,
        route: { id: F.route2, code: "2" },
        phase: "ROUTE_END",
      });
      // Made outside the route, though it names it: no moment.
      expect(columns[fixedId("0c40", 3)]).toEqual({
        routeId: F.route1,
        route: { id: F.route1, code: "1" },
        phase: null,
      });
    });

    it("never names another company's route, even one the row points at", async () => {
      expect((await columnsOf(F.B))[fixedId("0c40", 6)]).toEqual({
        routeId: F.route1,
        route: null,
        phase: "ROUTE_END",
      });
    });
  });

  describe("listRoutesAwaitingEndChecklist", () => {
    it("reads the driver's routes ended in the window without their arrival checklist", async () => {
      expect(
        await harness().repo.listRoutesAwaitingEndChecklist({
          businessId: F.A,
          driverId: F.driverA,
          completedSince: minute(100),
        }),
      ).toEqual([
        {
          id: F.route1,
          code: 1,
          plan_version: 3,
          vehicle: { id: F.vehicleA, license_plate: "CHK1A11" },
          completed_at: minute(200),
        },
      ]);
    });

    it("stays inside the company and the driver", async () => {
      expect(
        (
          await harness().repo.listRoutesAwaitingEndChecklist({
            businessId: F.B,
            driverId: F.driverB,
            completedSince: minute(100),
          })
        ).map((route) => route.id),
      ).toEqual([F.routeB]);
      expect(
        await harness().repo.listRoutesAwaitingEndChecklist({
          businessId: F.B,
          driverId: F.driverA,
          completedSince: minute(100),
        }),
      ).toEqual([]);
    });
  });
}

export {
  ROUTE_CHECKLIST_FIXTURE,
  ROUTE_CHECKLIST_SEED,
  ROUTE_SEED,
  routeChecklistContract,
};
export type { RouteChecklistHarness, RouteChecklistSeed, RouteSeed };
