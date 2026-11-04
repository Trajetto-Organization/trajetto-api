import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DriverTrailUseCase,
  TRAIL_POINT_LIMIT,
} from "@/modules/route/usecases/driver-trail/driver-trail-usecase";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import {
  decodeUnroutedCursor,
  encodeUnroutedCursor,
} from "@/modules/route/usecases/list-unrouted-deliveries/unrouted-deliveries";
import { ROUTE_MAX_STOPS } from "@/modules/route/usecases/shared/route-plan-rules";

/**
 * The route page's reads (plan of 02/11/2026, G9), on the twins:
 *
 * - the trail opened for a route reads the route's WINDOW (driver, departure,
 *   end), not the route with its two hundred stops and their deliveries, and
 *   asks the repository for at most TRAIL_POINT_LIMIT points — the thinning
 *   happens where the points are, the true count comes back beside them;
 * - the map's visited points keep the NEWEST arrivals and proofs when a route
 *   has more than the cap (the ascending `take` cut the end of the day);
 * - the "Adicionar entregas" picker pages by cursor (keyset), so a colleague
 *   routing a delivery between two pages neither duplicates nor skips a row,
 *   and only the first page pays for the counts.
 */
const COMPANY = "018f0000-0000-7000-8000-00000000c001";
const OTHER = "018f0000-0000-7000-8000-00000000c002";

const MANAGER = {
  id: "manager",
  businessId: COMPANY,
  role: "BUSINESS_ADMIN",
  driverId: null,
};

const users = {
  findUserById: async (id: string) => (id === MANAGER.id ? MANAGER : null),
} as never;

describe("the trail of a route reads the route's window, thinned at the source", () => {
  let positions: InMemoryDriverPositionRepository;
  let routes: InMemoryRouteRepository;

  beforeEach(async () => {
    positions = new InMemoryDriverPositionRepository();
    positions.drivers.push({ id: "d1", businessId: COMPANY, name: "Ana" });

    routes = new InMemoryRouteRepository(
      [],
      [],
      [{ id: "d1", businessId: COMPANY, name: "Ana", status: "ACTIVE" }],
    );
  });

  async function startedRoute(): Promise<string> {
    const created = await routes.createRoute({
      businessId: COMPANY,
      driverId: "d1",
      scheduled_date: new Date("2026-11-02T00:00:00.000Z"),
      deliveryIds: [],
    });

    const row = routes.routes.find((route) => route.id === created.id)!;
    row.status = "IN_PROGRESS";
    row.started_at = new Date("2026-11-02T11:00:00.000Z");

    return created.id;
  }

  function seedPoints(routeId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      positions.trail.push({
        driverId: "d1",
        businessId: COMPANY,
        routeId,
        latitude: -23.5 + index / 10_000,
        longitude: -46.6,
        accuracy: 10,
        speed: 30,
        heading: null,
        battery: null,
        recorded_at: new Date(Date.UTC(2026, 10, 2, 11, 0, 15 * (index + 1))),
      });
    }
  }

  const trail = () =>
    new DriverTrailUseCase(
      users,
      positions,
      new InMemoryOperationDayRepository(),
      routes,
    );

  it("never loads the route with its stops to read three fields", async () => {
    const routeId = await startedRoute();
    seedPoints(routeId, 3);

    const heavy = vi.spyOn(routes, "findRouteById");

    const result = await trail().execute({
      userId: MANAGER.id,
      driverId: "d1",
      routeId,
      now: new Date("2026-11-02T15:00:00.000Z"),
    });

    expect(heavy).not.toHaveBeenCalled();
    expect(result.recorded).toBe(3);
  });

  it("answers the same 404 for a route of another driver", async () => {
    const routeId = await startedRoute();

    routes.routes.find((route) => route.id === routeId)!.driverId = "d2";

    await expect(
      trail().execute({ userId: MANAGER.id, driverId: "d1", routeId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("asks the repository for at most the limit and reports the real count", async () => {
    const routeId = await startedRoute();
    seedPoints(routeId, TRAIL_POINT_LIMIT * 3 + 7);

    const read = vi.spyOn(positions, "listTrail");

    const result = await trail().execute({
      userId: MANAGER.id,
      driverId: "d1",
      routeId,
      now: new Date("2026-11-02T20:00:00.000Z"),
    });

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ max: TRAIL_POINT_LIMIT }),
    );
    expect(result.recorded).toBe(TRAIL_POINT_LIMIT * 3 + 7);
    expect(result.points).toHaveLength(TRAIL_POINT_LIMIT);

    // Where the day started and where the driver IS are always kept.
    expect(result.points[0].recordedAt).toBe(
      positions.trail[0].recorded_at.toISOString(),
    );
    expect(result.points[result.points.length - 1].recordedAt).toBe(
      positions.trail[positions.trail.length - 1].recorded_at.toISOString(),
    );
  });
});

describe("the map's visited points keep the end of the day", () => {
  it("keeps the newest arrivals and proofs, oldest first, when there are more than the cap", async () => {
    const routes = new InMemoryRouteRepository();
    const cap = 2 * ROUTE_MAX_STOPS;

    for (let index = 0; index < cap + 25; index += 1) {
      routes.events.push({
        type: index % 2 === 0 ? "ARRIVAL" : "PROOF",
        deliveryId: `delivery-${index}`,
        businessId: COMPANY,
        routeId: "route-1",
        reportedById: null,
        note: null,
        latitude: -23.5,
        longitude: -46.6,
        occurred_at: null,
        created_at: new Date(Date.UTC(2026, 10, 2, 8, 0, index)),
      });
    }

    const points = await routes.listVisitedPoints("route-1", COMPANY);

    expect(points).toHaveLength(cap);
    // The 25 OLDEST fall out, never the last proofs of the day.
    expect(points[0].deliveryId).toBe("delivery-25");
    expect(points[points.length - 1].deliveryId).toBe(`delivery-${cap + 24}`);
    expect(await routes.listVisitedPoints("route-1", OTHER)).toEqual([]);
  });

  it("carries each point's geofence record, for the stop's 'Fora do raio' flag (E5)", async () => {
    // The web's route page flags a stop whose arrival or proof was recorded
    // outside the radius (lib/geofence-flag, stopGeofenceFlags). It reads the
    // record with the delivery detail's names; a point from before the
    // geofence answers null, never a missing key.
    const routes = new InMemoryRouteRepository();
    const point = {
      deliveryId: "delivery-1",
      businessId: COMPANY,
      routeId: "route-1",
      reportedById: null,
      note: null,
      latitude: -23.5,
      longitude: -46.6,
      occurred_at: null,
    };

    routes.events.push(
      {
        ...point,
        type: "ARRIVAL",
        created_at: new Date(Date.UTC(2026, 10, 2, 8, 0, 0)),
        geofence_outcome: "OUTSIDE",
        distance_m: 820,
        accuracy_m: 12,
      },
      {
        ...point,
        type: "PROOF",
        created_at: new Date(Date.UTC(2026, 10, 2, 8, 5, 0)),
      },
    );

    const points = await routes.listVisitedPoints("route-1", COMPANY);

    expect(points).toEqual([
      expect.objectContaining({
        type: "ARRIVAL",
        geofence_outcome: "OUTSIDE",
        distance_m: 820,
        accuracy_m: 12,
      }),
      expect.objectContaining({
        type: "PROOF",
        geofence_outcome: null,
        distance_m: null,
        accuracy_m: null,
      }),
    ]);
  });
});

describe("the stop cards' 'Fora do raio' flag (E5)", () => {
  // An occurrence recorded outside the radius always passes, flagged (owner's
  // decision), and showed on the tower and the timeline but never on the
  // route detail's stop card: the card only read the map's points, which are
  // arrivals and proofs. The flag now comes per stop, from the newest
  // OUTSIDE record among the arrival, the proof and the occurrences.
  const base = {
    businessId: COMPANY,
    routeId: "route-1",
    reportedById: null,
    note: null,
    latitude: -23.5,
    longitude: -46.6,
    occurred_at: null,
  };

  it("flags a stop whose only record is an occurrence 800 m away", async () => {
    const routes = new InMemoryRouteRepository();

    routes.events.push(
      {
        ...base,
        deliveryId: "no-arrival",
        type: "OCCURRENCE",
        created_at: new Date(Date.UTC(2026, 10, 2, 9, 0, 0)),
        geofence_outcome: "OUTSIDE",
        distance_m: 800,
        accuracy_m: 15,
      },
      // Inside the radius: no flag.
      {
        ...base,
        deliveryId: "inside",
        type: "ARRIVAL",
        created_at: new Date(Date.UTC(2026, 10, 2, 9, 5, 0)),
        geofence_outcome: "INSIDE",
        distance_m: 40,
        accuracy_m: 8,
      },
      // An arrival outside and a later occurrence outside: the newest wins.
      {
        ...base,
        deliveryId: "twice",
        type: "ARRIVAL",
        created_at: new Date(Date.UTC(2026, 10, 2, 9, 10, 0)),
        geofence_outcome: "OUTSIDE",
        distance_m: 650,
        accuracy_m: 10,
      },
      {
        ...base,
        deliveryId: "twice",
        type: "OCCURRENCE",
        created_at: new Date(Date.UTC(2026, 10, 2, 9, 20, 0)),
        geofence_outcome: "OUTSIDE",
        distance_m: 900,
        accuracy_m: 20,
      },
      // Another route's record is not this route's stop.
      {
        ...base,
        deliveryId: "elsewhere",
        routeId: "route-2",
        type: "OCCURRENCE",
        created_at: new Date(Date.UTC(2026, 10, 2, 9, 30, 0)),
        geofence_outcome: "OUTSIDE",
        distance_m: 700,
        accuracy_m: 5,
      },
    );

    const flags = await routes.listStopGeofence("route-1", COMPANY);

    expect(
      [...flags].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)),
    ).toEqual([
      {
        deliveryId: "no-arrival",
        type: "OCCURRENCE",
        geofence_outcome: "OUTSIDE",
        distance_m: 800,
        accuracy_m: 15,
        recordedAt: new Date(Date.UTC(2026, 10, 2, 9, 0, 0)),
      },
      {
        deliveryId: "twice",
        type: "OCCURRENCE",
        geofence_outcome: "OUTSIDE",
        distance_m: 900,
        accuracy_m: 20,
        recordedAt: new Date(Date.UTC(2026, 10, 2, 9, 20, 0)),
      },
    ]);

    expect(await routes.listStopGeofence("route-1", OTHER)).toEqual([]);
  });
});

describe("the 'Adicionar entregas' picker pages by cursor", () => {
  let routes: InMemoryRouteRepository;

  beforeEach(() => {
    const deliveries = Array.from({ length: 7 }, (_, index) => ({
      id: `018f0000-0000-7000-8000-0000000d00${index}0`,
      businessId: COMPANY,
      status: "PENDING",
      recipient_name: `Cliente ${index}`,
      city: "Campinas",
      uf: "SP",
      street: "Rua",
      // Two without a day (last), the rest over three days, ties on the day.
      scheduled_date:
        index >= 5
          ? null
          : new Date(`2026-11-0${3 + Math.floor(index / 2)}T00:00:00.000Z`),
      created_at: new Date(Date.UTC(2026, 10, 1, 8, index)),
    }));

    routes = new InMemoryRouteRepository([
      ...deliveries,
      {
        id: "018f0000-0000-7000-8000-0000000d0999",
        businessId: OTHER,
        status: "PENDING",
        recipient_name: "Cliente de outra empresa",
        city: "Campinas",
        uf: "SP",
        street: "Rua",
        scheduled_date: null,
        created_at: new Date(Date.UTC(2026, 10, 1, 7)),
      },
    ]);
  });

  const page = (cursor?: string) =>
    routes.listUnroutedDeliveries({
      businessId: COMPANY,
      page: 1,
      pageSize: 3,
      ...(cursor && { after: decodeUnroutedCursor(cursor) }),
    });

  it("walks every row once in (day nulls last, created_at, id) order, counting only on the first page", async () => {
    const first = await page();

    expect(first.total).toBe(7);
    expect(first.facets?.city).toEqual([{ value: "Campinas", count: 7 }]);
    expect(first.nextCursor).not.toBeNull();

    const second = await page(first.nextCursor!);

    // Later pages skip the five counts: the picker shows the first page's.
    expect(second.total).toBeUndefined();
    expect(second.facets).toBeUndefined();

    const third = await page(second.nextCursor!);

    expect(third.nextCursor).toBeNull();

    const ids = [...first.data, ...second.data, ...third.data].map(
      (row) => row.recipient_name,
    );

    expect(ids).toEqual([
      "Cliente 0",
      "Cliente 1",
      "Cliente 2",
      "Cliente 3",
      "Cliente 4",
      "Cliente 5",
      "Cliente 6",
    ]);
  });

  it("neither duplicates nor skips a row when a colleague routes one between pages", async () => {
    const first = await page();

    // Somebody routes the first row while the dispatcher scrolls: with an
    // offset, page two would start one row later and skip "Cliente 3".
    await routes.createRoute({
      businessId: COMPANY,
      driverId: "d1",
      scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
      deliveryIds: [first.data[0].id],
    });

    const second = await page(first.nextCursor!);

    expect(second.data.map((row) => row.recipient_name)).toEqual([
      "Cliente 3",
      "Cliente 4",
      "Cliente 5",
    ]);
  });

  it("round-trips the cursor and refuses a forged one", () => {
    const key = {
      scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
      created_at: new Date("2026-11-01T08:00:00.000Z"),
      id: "018f0000-0000-7000-8000-0000000d0000",
    };

    expect(decodeUnroutedCursor(encodeUnroutedCursor(key))).toEqual(key);
    expect(
      decodeUnroutedCursor(
        encodeUnroutedCursor({ ...key, scheduled_date: null }),
      ),
    ).toEqual({ ...key, scheduled_date: null });

    for (const forged of ["nao-e-cursor", "eyJ4IjoxfQ", ""]) {
      expect(() => decodeUnroutedCursor(forged)).toThrowError(
        expect.objectContaining({ code: "INVALID_CURSOR", statusCode: 400 }),
      );
    }
  });
});
