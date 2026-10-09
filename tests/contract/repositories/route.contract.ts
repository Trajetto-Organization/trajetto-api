import { describe, expect, it } from "vitest";

import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { CreateRouteProps } from "@/modules/route/dtos/route-dto";
import {
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
} from "@/modules/route/usecases/errors/route-errors";

import { expectPrismaCode, fixedId, type Kind } from "../support";

/**
 * The route repository's contract (decision 13.2): the plan writes that
 * turn deliveries into stops (createRoute, addStops), their refusals, the
 * per-company code, the tenant wall on reads, and the Rotas listing.
 */

const A = fixedId("0e0a", 1);
const B = fixedId("0e0a", 2);

const ROUTE_FIXTURE = {
  A,
  B,
  driverA1: fixedId("0ed0", 1),
  driverA2: fixedId("0ed0", 2),
  driverB: fixedId("0ed0", 3),
  vehicleA: fixedId("0efe", 1),
  plate: "RTA1B23",
  driverA1Name: "Bruno Lima",
  driverA2Name: "Ágata Souza",
  driverBName: "Bruno de Outra",
  /** Deliveries: p* PENDING in A, done1 DELIVERED in A, b* PENDING in B (b1 on a route). */
  deliveries: {
    p1: fixedId("0ede", 1),
    p2: fixedId("0ede", 2),
    p3: fixedId("0ede", 3),
    p4: fixedId("0ede", 4),
    p5: fixedId("0ede", 5),
    p6: fixedId("0ede", 6),
    done1: fixedId("0ede", 7),
    b1: fixedId("0ede", 8),
    b2: fixedId("0ede", 9),
  },
  day1: new Date("2026-09-10T00:00:00.000Z"),
  day2: new Date("2026-09-11T00:00:00.000Z"),
} as const;

const F = ROUTE_FIXTURE;
const D = F.deliveries;
const MISSING = fixedId("0ede", 99);

interface RouteHarness {
  kind: Kind;
  repo: IRouteRepository;
  /** The route ids created by seedRoutes, by key. */
  route(key: string): string;
}

/** The plan every case reads, created through the repository. */
async function seedRoutes(
  repo: IRouteRepository,
  pinCreatedAt: (routeId: string, at: Date) => Promise<void>,
): Promise<Map<string, string>> {
  const routes = new Map<string, string>();
  const make = async (
    key: string,
    minute: number,
    data: Omit<CreateRouteProps, "businessId"> & { businessId?: string },
  ) => {
    const created = await repo.createRoute({ businessId: A, ...data });
    routes.set(key, created.id);
    await pinCreatedAt(created.id, new Date(Date.UTC(2026, 8, 1, 12, minute)));
  };

  await make("r1", 1, {
    name: "Zona Norte",
    driverId: F.driverA1,
    vehicleId: F.vehicleA,
    scheduled_date: F.day1,
    deliveryIds: [D.p1, D.p2],
    client_submission_id: "route-sub-1",
  });
  await make("r2", 2, {
    name: "centro expresso",
    driverId: F.driverA2,
    scheduled_date: F.day2,
    deliveryIds: [D.p3],
  });
  await make("r3", 2, {
    name: null,
    driverId: F.driverA1,
    scheduled_date: F.day1,
    deliveryIds: [],
  });
  await make("rb", 0, {
    businessId: B,
    name: "Zona Norte de B",
    driverId: F.driverB,
    scheduled_date: F.day1,
    deliveryIds: [D.b1],
    client_submission_id: "route-sub-1",
  });

  return routes;
}

function routeRepositoryContract(harness: () => RouteHarness): void {
  const list = (
    extra: Partial<Parameters<IRouteRepository["listRoutes"]>[0]> = {},
  ) =>
    harness().repo.listRoutes({
      page: 1,
      pageSize: 50,
      businessId: A,
      ...extra,
    });

  describe("createRoute", () => {
    it("numbers routes per company and turns the deliveries into stops in the given order", async () => {
      const h = harness();
      const r1 = await h.repo.findRouteById(h.route("r1"), A);
      const rb = await h.repo.findRouteById(h.route("rb"), B);

      expect(r1).toMatchObject({
        code: 1,
        status: "PLANNED",
        name: "Zona Norte",
        destination: null,
        driver: { id: F.driverA1, name: F.driverA1Name },
        vehicle: { id: F.vehicleA, license_plate: F.plate },
      });
      expect(r1!.scheduled_date).toEqual(F.day1);
      expect(
        r1!.stops.map((stop) => [stop.sequence, stop.status, stop.deliveryId]),
      ).toEqual([
        [10, "PENDING", D.p1],
        [20, "PENDING", D.p2],
      ]);
      expect(r1!.stops[0].delivery).toMatchObject({
        id: D.p1,
        status: "PENDING",
        recipient_name: "Cliente p1",
      });
      expect(rb?.code).toBe(1);
    });

    it("refuses the same delivery twice in one route (one open stop per delivery)", async () => {
      await expect(
        harness().repo.createRoute({
          businessId: A,
          driverId: F.driverA1,
          scheduled_date: F.day1,
          deliveryIds: [D.p4, D.p4],
        }),
      ).rejects.toBeInstanceOf(DeliveryAlreadyOnRouteError);
    });

    it("refuses a delivery already on an open route", async () => {
      await expect(
        harness().repo.createRoute({
          businessId: A,
          driverId: F.driverA2,
          scheduled_date: F.day1,
          deliveryIds: [D.p4, D.p1],
        }),
      ).rejects.toBeInstanceOf(DeliveryAlreadyOnRouteError);
    });

    it("refuses another company's delivery and one no longer pending, as a short mirror count", async () => {
      const { repo } = harness();
      const plan = (deliveryIds: string[]) =>
        repo.createRoute({
          businessId: A,
          driverId: F.driverA1,
          scheduled_date: F.day1,
          deliveryIds,
        });

      await expect(plan([D.p4, D.b2])).rejects.toBeInstanceOf(
        DeliveryNoLongerRoutableError,
      );
      await expect(plan([D.done1])).rejects.toBeInstanceOf(
        DeliveryNoLongerRoutableError,
      );
    });

    it("refuses a delivery id that does not exist (P2003, the stop's foreign key)", async () => {
      await expectPrismaCode(
        harness().repo.createRoute({
          businessId: A,
          driverId: F.driverA1,
          scheduled_date: F.day1,
          deliveryIds: [MISSING],
        }),
        "P2003",
      );
    });

    it("writes nothing when it refuses", async () => {
      const page = await list();

      expect(page.total).toBe(3);
      expect(page.data.map((route) => route.code).sort()).toEqual([1, 2, 3]);
    });

    it("refuses a replayed submission key in the company (P2002) and finds the route by it", async () => {
      const h = harness();

      await expectPrismaCode(
        h.repo.createRoute({
          businessId: A,
          driverId: F.driverA1,
          scheduled_date: F.day1,
          deliveryIds: [],
          client_submission_id: "route-sub-1",
        }),
        "P2002",
      );

      expect((await h.repo.findRouteBySubmission(A, "route-sub-1"))?.id).toBe(
        h.route("r1"),
      );
      expect((await h.repo.findRouteBySubmission(B, "route-sub-1"))?.id).toBe(
        h.route("rb"),
      );
      expect(await h.repo.findRouteBySubmission(A, "nope")).toBeNull();
    });
  });

  describe("addStops", () => {
    it("refuses duplicates, foreign, finished and unknown deliveries, adding nothing", async () => {
      const h = harness();
      const add = (deliveryIds: string[]) =>
        h.repo.addStops(h.route("r3"), A, deliveryIds);

      await expect(add([D.p5, D.p5])).rejects.toBeInstanceOf(
        DeliveryAlreadyOnRouteError,
      );
      await expect(add([D.p5, D.b2])).rejects.toBeInstanceOf(
        DeliveryNoLongerRoutableError,
      );
      await expect(add([D.done1])).rejects.toBeInstanceOf(
        DeliveryNoLongerRoutableError,
      );
      await expectPrismaCode(add([MISSING]), "P2003");

      expect((await h.repo.findRouteById(h.route("r3"), A))!.stops).toEqual([]);
    });

    it("appends after the highest sequence", async () => {
      const h = harness();

      const added = await h.repo.addStops(h.route("r2"), A, [D.p6]);

      expect(
        added.stops.map((stop) => [stop.sequence, stop.deliveryId]),
      ).toEqual([[20, D.p6]]);
      expect(added.code).toBe(2);
    });
  });

  describe("reads", () => {
    it("never answer another company's route", async () => {
      const h = harness();

      expect(await h.repo.findRouteById(h.route("rb"), A)).toBeNull();
      expect(await h.repo.findRouteById(MISSING, A)).toBeNull();
    });

    it("list one company newest first, the id breaking a created_at tie", async () => {
      const h = harness();
      const tie = [h.route("r2"), h.route("r3")].sort().reverse();

      expect((await list()).data.map((route) => route.id)).toEqual([
        ...tie,
        h.route("r1"),
      ]);
    });

    it("search the name case-insensitively, the driver's name and the code", async () => {
      const h = harness();
      const found = async (search: string) =>
        (await list({ search })).data.map((route) => route.id).sort();

      expect(await found("CENTRO")).toEqual([h.route("r2")]);
      expect(await found("ágata")).toEqual([h.route("r2")]);
      expect(await found("bruno")).toEqual(
        [h.route("r1"), h.route("r3")].sort(),
      );
      expect(await found("#3")).toEqual([h.route("r3")]);
      expect(await found("Rota 1")).toEqual([h.route("r1")]);
    });

    it("filter by the scheduled day and by driver, counting facets without their own filter", async () => {
      const h = harness();

      const day = await list({ scheduled_date: F.day1 });
      expect(day.data.map((route) => route.id).sort()).toEqual(
        [h.route("r1"), h.route("r3")].sort(),
      );

      const byDriver = await list({ driverIds: [F.driverA2] });
      expect(byDriver.data.map((route) => route.id)).toEqual([h.route("r2")]);
      expect(byDriver.total).toBe(1);
    });
  });
}

export { ROUTE_FIXTURE, routeRepositoryContract, seedRoutes };
export type { RouteHarness };
