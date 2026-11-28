import { beforeEach, describe, expect, it } from "vitest";

import { LiveRoutesUseCase } from "@/modules/route/usecases/live-routes/live-routes-usecase";
import {
  LIVE_ROUTES_CAP,
  decodeLiveRoutesCursor,
  encodeLiveRoutesCursor,
} from "@/modules/route/usecases/live-routes/live-routes";
import {
  InMemoryOperationDayRepository,
  type OperationRows,
} from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";

/**
 * GET /route/live (wave 4): the tower's list of routes on the street, lean,
 * for the manager's phone and wave 5's map.
 *
 * The clock is 22:00 in São Paulo on the 17th, which is already the 18th in
 * UTC: "released for today" must be the company's today, as on the tower.
 */
const NOW = new Date("2026-09-18T01:00:00.000Z");

const SP = "018f4400-0000-7000-8000-00000000a001";
const OTHER = "018f4400-0000-7000-8000-00000000a002";

const ADMIN = { id: "admin", businessId: SP, role: "BUSINESS_ADMIN" };
const OTHER_ADMIN = { id: "other", businessId: OTHER, role: "BUSINESS_ADMIN" };
const MASTER = { id: "master", businessId: null, role: "MASTER" };
const DRIVER_USER = {
  id: "driver-user",
  businessId: SP,
  role: "BUSINESS_USER",
  driverId: "d1",
};

const users = [ADMIN, OTHER_ADMIN, MASTER, DRIVER_USER];

const userRepository = {
  findUserById: async (id: string) =>
    users.find((user) => user.id === id) ?? null,
} as never;

const at = (iso: string) => new Date(iso);
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

let operation: InMemoryOperationDayRepository;
let pendingAsked: Array<{ businessId: string; routeIds: string[] }>;
let pendingCounts: Map<string, number>;

const authorizations = {
  countPendingByRoute: async (businessId: string, routeIds: string[]) => {
    pendingAsked.push({ businessId, routeIds });

    return new Map(
      [...pendingCounts].filter(([routeId]) => routeIds.includes(routeId)),
    );
  },
} as never;

function useCase() {
  return new LiveRoutesUseCase(userRepository, operation, authorizations);
}

function route(
  overrides: Partial<OperationRows["routes"][number]> & {
    id: string;
    code: number;
  },
): OperationRows["routes"][number] {
  return {
    businessId: SP,
    name: null,
    destination: null,
    status: "IN_PROGRESS",
    scheduled_date: day("2026-09-17"),
    planned_departure_at: null,
    started_at: at("2026-09-17T12:00:00.000Z"),
    completed_at: null,
    updated_at: NOW,
    driverId: "d1",
    vehicleId: null,
    ...overrides,
  };
}

function stop(
  id: string,
  routeId: string,
  status: string,
): OperationRows["stops"][number] {
  return {
    id,
    routeId,
    deliveryId: `delivery-${id}`,
    sequence: 1,
    status,
    on_the_way_at: null,
    arrived_at: null,
    completed_at: null,
    updated_at: NOW,
  };
}

beforeEach(() => {
  operation = new InMemoryOperationDayRepository();
  pendingAsked = [];
  pendingCounts = new Map();

  operation.rows.businesses.push(
    { id: SP, timezone: "America/Sao_Paulo" },
    { id: OTHER, timezone: "America/Sao_Paulo" },
  );

  operation.rows.drivers.push(
    { id: "d1", businessId: SP, name: "Ana" },
    { id: "d2", businessId: SP, name: "Bruno" },
    { id: "dx", businessId: OTHER, name: "Xavier" },
  );

  operation.rows.vehicles.push({ id: "v1", license_plate: "ABC1D23" });
});

describe("which routes are live", () => {
  beforeEach(() => {
    operation.rows.routes.push(
      route({ id: "r1", code: 11, vehicleId: "v1" }),
      // Started two days ago and never closed: still on the street.
      route({
        id: "r2",
        code: 3,
        driverId: "d2",
        scheduled_date: day("2026-09-15"),
        started_at: at("2026-09-15T11:00:00.000Z"),
      }),
      route({
        id: "r3",
        code: 7,
        status: "RELEASED",
        started_at: null,
      }),
      // Released for the UTC date of NOW, which is tomorrow in São Paulo.
      route({
        id: "r4",
        code: 8,
        status: "RELEASED",
        scheduled_date: day("2026-09-18"),
        started_at: null,
      }),
      // Released for yesterday and never started: not "for today".
      route({
        id: "r5",
        code: 9,
        status: "RELEASED",
        scheduled_date: day("2026-09-16"),
        started_at: null,
      }),
      route({ id: "r6", code: 10, status: "PLANNED", started_at: null }),
      route({
        id: "r7",
        code: 12,
        status: "COMPLETED",
        completed_at: at("2026-09-17T20:00:00.000Z"),
      }),
      route({ id: "r8", code: 13, status: "CANCELLED" }),
      { ...route({ id: "rx", code: 1, driverId: "dx" }), businessId: OTHER },
    );
  });

  it("lists the running ones (any day) and today's released ones, running first, each by code", async () => {
    const { data, meta } = await useCase().execute({
      userId: ADMIN.id,
      now: NOW,
    });

    expect(data.map((row) => [row.id, row.status])).toEqual([
      ["r2", "IN_PROGRESS"],
      ["r1", "IN_PROGRESS"],
      ["r3", "RELEASED"],
    ]);

    // The company's day, not the server's (UTC is already the 18th).
    expect(meta).toMatchObject({
      day: "2026-09-17",
      timeZone: "America/Sao_Paulo",
      generatedAt: NOW.toISOString(),
      silentAfterMs: 10 * 60 * 1000,
      limit: LIVE_ROUTES_CAP,
      truncated: false,
      nextCursor: null,
    });
  });

  it("names the driver and the plate, and flags the route left open as the tower does", async () => {
    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    const byId = new Map(data.map((row) => [row.id, row]));

    expect(byId.get("r1")).toMatchObject({
      code: 11,
      driverId: "d1",
      driver_name: "Ana",
      vehicle_plate: "ABC1D23",
      scheduled_date: "2026-09-17",
      started_at: "2026-09-17T12:00:00.000Z",
      stale: false,
    });
    expect(byId.get("r2")).toMatchObject({
      driver_name: "Bruno",
      vehicle_plate: null,
      stale: true,
    });

    // Released and not started: never "left open".
    expect(byId.get("r3")).toMatchObject({ started_at: null, stale: false });
  });

  it("never lists another company's route", async () => {
    const own = await useCase().execute({ userId: ADMIN.id, now: NOW });
    const other = await useCase().execute({
      userId: OTHER_ADMIN.id,
      now: NOW,
    });

    expect(own.data.some((row) => row.id === "rx")).toBe(false);
    expect(other.data.map((row) => row.id)).toEqual(["rx"]);
  });
});

describe("what each row counts", () => {
  beforeEach(() => {
    operation.rows.routes.push(
      route({ id: "r1", code: 1 }),
      route({ id: "r2", code: 2, driverId: "d2" }),
    );

    operation.rows.stops.push(
      stop("s1", "r1", "COMPLETED"),
      stop("s2", "r1", "FAILED"),
      stop("s3", "r1", "PENDING"),
      stop("s4", "r1", "ARRIVED"),
      stop("s5", "r1", "CANCELLED"),
    );
  });

  it('counts "8 de 12" as resolved over the stops that were not cancelled', async () => {
    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(data[0]).toMatchObject({
      id: "r1",
      stops_total: 4,
      stops_resolved: 2,
    });
    expect(data[1]).toMatchObject({
      id: "r2",
      stops_total: 0,
      stops_resolved: 0,
    });
  });

  it("asks the pending requests of the page's routes only, in the company", async () => {
    pendingCounts.set("r1", 2);
    pendingCounts.set("elsewhere", 5);

    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(pendingAsked).toEqual([{ businessId: SP, routeIds: ["r1", "r2"] }]);
    expect(data.map((row) => row.pending_authorizations)).toEqual([2, 0]);
  });

  it("does not ask for pending requests when nothing is live", async () => {
    operation.rows.routes = [];

    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(data).toEqual([]);
    expect(pendingAsked).toEqual([]);
  });
});

describe("the last signal", () => {
  beforeEach(() => {
    operation.rows.routes.push(
      route({ id: "r1", code: 1, driverId: "d1" }),
      route({ id: "r2", code: 2, driverId: "d2" }),
      route({ id: "r3", code: 3, driverId: "dx" }),
    );
  });

  it("gives the point for the map only inside the tower's 12 hours, and its age always", async () => {
    operation.rows.lastPositions = [
      {
        driverId: "d1",
        businessId: SP,
        latitude: -23.55,
        longitude: -46.63,
        recorded_at: at("2026-09-18T00:52:00.000Z"),
      },
      // Yesterday's dot: not where the truck is, but still its last signal.
      {
        driverId: "d2",
        businessId: SP,
        latitude: -23.5,
        longitude: -46.6,
        recorded_at: at("2026-09-17T10:00:00.000Z"),
      },
    ];

    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(data[0]).toMatchObject({
      position: {
        lat: -23.55,
        lng: -46.63,
        recorded_at: "2026-09-18T00:52:00.000Z",
      },
      last_signal_at: "2026-09-18T00:52:00.000Z",
    });
    expect(data[1]).toMatchObject({
      position: null,
      last_signal_at: "2026-09-17T10:00:00.000Z",
    });
  });

  it("says never for a phone that never reported", async () => {
    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(data[0]).toMatchObject({ position: null, last_signal_at: null });
  });

  it("does not read another company's row for the same driver", async () => {
    // A driver moved between companies keeps one last_position row; the
    // route of the old company must not show the new one's point.
    operation.rows.lastPositions = [
      {
        driverId: "dx",
        businessId: OTHER,
        latitude: 1,
        longitude: 1,
        recorded_at: at("2026-09-18T00:59:00.000Z"),
      },
    ];

    const { data } = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(data[2]).toMatchObject({
      id: "r3",
      position: null,
      last_signal_at: null,
    });
  });
});

describe("the cap", () => {
  beforeEach(() => {
    for (let code = 1; code <= LIVE_ROUTES_CAP + 2; code += 1) {
      operation.rows.routes.push(
        route({
          id: `r${code}`,
          code,
          // The last three are released: they come after every running one.
          ...(code > LIVE_ROUTES_CAP - 1
            ? { status: "RELEASED" as const, started_at: null }
            : {}),
        }),
      );
    }
  });

  it("stops at 500, says so, and hands the cursor of the next page", async () => {
    const first = await useCase().execute({ userId: ADMIN.id, now: NOW });

    expect(first.data).toHaveLength(LIVE_ROUTES_CAP);
    expect(first.meta.truncated).toBe(true);
    expect(first.meta.nextCursor).not.toBeNull();

    // The pending counts are asked for the page, never past the cap.
    expect(pendingAsked[0].routeIds).toHaveLength(LIVE_ROUTES_CAP);

    const second = await useCase().execute({
      userId: ADMIN.id,
      cursor: first.meta.nextCursor!,
      now: NOW,
    });

    expect(second.data.map((row) => row.code)).toEqual([
      LIVE_ROUTES_CAP + 1,
      LIVE_ROUTES_CAP + 2,
    ]);
    expect(second.meta).toMatchObject({ truncated: false, nextCursor: null });

    // Nothing repeated and nothing skipped across the two pages.
    const seen = [...first.data, ...second.data].map((row) => row.id);

    expect(new Set(seen).size).toBe(LIVE_ROUTES_CAP + 2);
  });

  it("is not truncated at exactly the cap", async () => {
    operation.rows.routes = operation.rows.routes.slice(0, LIVE_ROUTES_CAP);

    const { data, meta } = await useCase().execute({
      userId: ADMIN.id,
      now: NOW,
    });

    expect(data).toHaveLength(LIVE_ROUTES_CAP);
    expect(meta).toMatchObject({ truncated: false, nextCursor: null });
  });
});

describe("the cursor", () => {
  it("round-trips the key", () => {
    expect(
      decodeLiveRoutesCursor(encodeLiveRoutesCursor({ rank: 1, code: 42 })),
    ).toEqual({ rank: 1, code: 42 });
  });

  it("takes the largest code the column holds", () => {
    // route.code is a Postgres integer; the repository binds it as ::int.
    expect(
      decodeLiveRoutesCursor(
        encodeLiveRoutesCursor({ rank: 0, code: 2_147_483_647 }),
      ),
    ).toEqual({ rank: 0, code: 2_147_483_647 });
  });

  it.each([
    ["not base64 JSON", "!!!"],
    ["a JSON that is not the key", Buffer.from("[1]").toString("base64url")],
    [
      "a rank outside the order",
      Buffer.from(JSON.stringify({ r: 2, c: 1 })).toString("base64url"),
    ],
    [
      "a code that is not an integer",
      Buffer.from(JSON.stringify({ r: 0, c: 1.5 })).toString("base64url"),
    ],
    [
      "a negative code",
      Buffer.from(JSON.stringify({ r: 0, c: -1 })).toString("base64url"),
    ],
    [
      "a code as text",
      Buffer.from(JSON.stringify({ r: 0, c: "1" })).toString("base64url"),
    ],
    [
      // Past the integer column: Postgres refused the ::int bind with
      // "integer out of range", which surfaced as a 500.
      "a code past the column's range",
      Buffer.from(JSON.stringify({ r: 0, c: 9_999_999_999 })).toString(
        "base64url",
      ),
    ],
    [
      "a code one past the column's range",
      Buffer.from(JSON.stringify({ r: 1, c: 2_147_483_648 })).toString(
        "base64url",
      ),
    ],
  ])(
    "refuses %s with 400 INVALID_CURSOR, before reading anything",
    async (_case, cursor) => {
      await expect(
        useCase().execute({ userId: "nobody", cursor, now: NOW }),
      ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_CURSOR" });
    },
  );
});

describe("who reads it", () => {
  beforeEach(() => {
    operation.rows.routes.push(route({ id: "r1", code: 1 }), {
      ...route({ id: "rx", code: 1, driverId: "dx" }),
      businessId: OTHER,
    });
  });

  it("refuses a driver token: the list is the whole fleet", async () => {
    await expect(
      useCase().execute({ userId: DRIVER_USER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_VIEW_PANELS",
    });
  });

  it("asks a MASTER which company, and reads the one named", async () => {
    await expect(
      useCase().execute({ userId: MASTER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const { data } = await useCase().execute({
      userId: MASTER.id,
      businessId: OTHER,
      now: NOW,
    });

    expect(data.map((row) => row.id)).toEqual(["rx"]);
  });

  it("refuses a company login naming another company", async () => {
    await expect(
      useCase().execute({ userId: ADMIN.id, businessId: OTHER, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("answers 404 for a session whose user is gone", async () => {
    await expect(
      useCase().execute({ userId: "gone", now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
