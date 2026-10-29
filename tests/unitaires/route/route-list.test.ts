import { describe, expect, it } from "vitest";

import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import {
  catalogFacetOptions,
  routeListWhere,
  summarizeRouteList,
} from "@/modules/route/usecases/list-routes/route-list";

import type { RouteStatus } from "@/shared/route/route-rules";

/**
 * The routes board's rules (decision 8.8) as pure functions, and the
 * in-memory twin answering the SAME scenario as tests/E2E/route-list-http
 * with the same orders and counts (decision 13.2): a twin that ordered or
 * counted differently would let the unit suite prove a board Postgres never
 * shows.
 */
const CARRIER = "carrier-a";
const OTHER = "carrier-b";

const ANA = "drv-ana";
const BRUNO = "drv-bruno";
const CARLA = "drv-carla";
const FOREIGN_DRIVER = "drv-foreign";

const TRUCK_A = "veh-a";
const TRUCK_B = "veh-b";
const FOREIGN_TRUCK = "veh-foreign";

const TIE_4 = "018fe200-0000-7000-8000-0000000009a4";
const TIE_5 = "018fe200-0000-7000-8000-0000000001a5";
const TIE_7 = "018fe200-0000-7000-8000-000000000107";
const TIE_8 = "018fe200-0000-7000-8000-000000000908";

interface Seed {
  code: number;
  status: RouteStatus;
  driverId: string;
  vehicleId: string | null;
  destination: string | null;
  startedMinutes: number | null;
  id?: string;
  at?: number;
}

// Same thirteen routes as the E2E.
const SEED: Seed[] = [
  {
    code: 1,
    status: "COMPLETED",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: "CD Norte",
    startedMinutes: 10,
  },
  {
    code: 2,
    status: "CANCELLED",
    driverId: BRUNO,
    vehicleId: null,
    destination: null,
    startedMinutes: null,
  },
  {
    code: 3,
    status: "PLANNED",
    driverId: CARLA,
    vehicleId: TRUCK_B,
    destination: "CD Sul",
    startedMinutes: null,
  },
  {
    code: 4,
    status: "PLANNED",
    driverId: ANA,
    vehicleId: null,
    destination: "Zona Leste",
    startedMinutes: null,
    id: TIE_4,
    at: 4,
  },
  {
    code: 5,
    status: "RELEASED",
    driverId: BRUNO,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: null,
    id: TIE_5,
    at: 4,
  },
  {
    code: 6,
    status: "IN_PROGRESS",
    driverId: CARLA,
    vehicleId: TRUCK_B,
    destination: "CD Oeste",
    startedMinutes: 30,
  },
  {
    code: 7,
    status: "RELEASED",
    driverId: ANA,
    vehicleId: TRUCK_B,
    destination: null,
    startedMinutes: null,
    id: TIE_7,
    at: 7,
  },
  {
    code: 8,
    status: "PLANNED",
    driverId: BRUNO,
    vehicleId: null,
    destination: "CD Norte",
    startedMinutes: null,
    id: TIE_8,
    at: 7,
  },
  {
    code: 9,
    status: "COMPLETED",
    driverId: CARLA,
    vehicleId: TRUCK_A,
    destination: "Zona Oeste",
    startedMinutes: 5,
  },
  {
    code: 10,
    status: "CANCELLED",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: 20,
  },
  {
    code: 11,
    status: "PLANNED",
    driverId: BRUNO,
    vehicleId: TRUCK_B,
    destination: "Centro",
    startedMinutes: null,
  },
  {
    code: 12,
    status: "COMPLETED",
    driverId: CARLA,
    vehicleId: null,
    destination: "CD Sul",
    startedMinutes: 15,
  },
  {
    code: 13,
    status: "IN_PROGRESS",
    driverId: ANA,
    vehicleId: TRUCK_A,
    destination: null,
    startedMinutes: 40,
  },
];

const BASE = new Date("2026-09-10T12:00:00.000Z").getTime();

async function seededBoard(): Promise<InMemoryRouteRepository> {
  const repository = new InMemoryRouteRepository(
    [],
    [
      {
        id: TRUCK_A,
        businessId: CARRIER,
        license_plate: "AAA1A11",
        status: "ACTIVE",
      },
      {
        id: TRUCK_B,
        businessId: CARRIER,
        license_plate: "BBB2B22",
        status: "ACTIVE",
      },
      {
        id: FOREIGN_TRUCK,
        businessId: OTHER,
        license_plate: "ZZZ9Z99",
        status: "ACTIVE",
      },
    ],
    [
      { id: ANA, businessId: CARRIER, name: "Ana", status: "ACTIVE" },
      { id: BRUNO, businessId: CARRIER, name: "Bruno", status: "ACTIVE" },
      { id: CARLA, businessId: CARRIER, name: "Carla", status: "ACTIVE" },
      {
        id: FOREIGN_DRIVER,
        businessId: OTHER,
        name: "Motorista alheio",
        status: "ACTIVE",
      },
    ],
  );

  for (const entry of SEED) {
    const created = await repository.createRoute({
      businessId: CARRIER,
      driverId: entry.driverId,
      vehicleId: entry.vehicleId,
      name: `Rota do dia ${entry.code}`,
      destination: entry.destination,
      scheduled_date: new Date("2026-09-10"),
      deliveryIds: [],
    });

    const row = repository.routes.find((route) => route.id === created.id)!;
    const createdAt = new Date(BASE + (entry.at ?? entry.code) * 60_000);

    Object.assign(row, {
      id:
        entry.id ??
        `018fe200-0000-7000-8000-${String(entry.code).padStart(12, "0")}`,
      code: entry.code,
      status: entry.status,
      started_at:
        entry.startedMinutes === null
          ? null
          : new Date(BASE + entry.startedMinutes * 60_000),
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  for (const code of [1, 2, 3]) {
    const created = await repository.createRoute({
      businessId: OTHER,
      driverId: FOREIGN_DRIVER,
      vehicleId: FOREIGN_TRUCK,
      scheduled_date: new Date("2026-09-10"),
      deliveryIds: [],
    });

    repository.routes.find((route) => route.id === created.id)!.code = code;
  }

  return repository;
}

async function codesOf(
  repository: InMemoryRouteRepository,
  query: Partial<Parameters<InMemoryRouteRepository["listRoutes"]>[0]> = {},
): Promise<number[]> {
  const first = await repository.listRoutes({
    businessId: CARRIER,
    page: 1,
    pageSize: 10,
    ...query,
  });
  const second = await repository.listRoutes({
    businessId: CARRIER,
    page: 2,
    pageSize: 10,
    ...query,
  });

  return [...first.data, ...second.data].map((route) => route.code);
}

describe("the in-memory board answers what Postgres answers", () => {
  it("orders like the Prisma query, the id breaking ties in both directions", async () => {
    const repository = await seededBoard();

    expect(await codesOf(repository)).toEqual([
      13, 12, 11, 10, 9, 8, 7, 6, 4, 5, 3, 2, 1,
    ]);
    expect(
      await codesOf(repository, { sort: "created_at", order: "asc" }),
    ).toEqual([1, 2, 3, 4, 5, 6, 8, 7, 9, 10, 11, 12, 13]);
    expect(
      await codesOf(repository, { sort: "driverName", order: "asc" }),
    ).toEqual([13, 10, 7, 4, 1, 11, 8, 5, 2, 12, 9, 6, 3]);
  });

  it("places NULLs where Postgres does: plate by default, departure always last", async () => {
    const repository = await seededBoard();

    expect(
      await codesOf(repository, { sort: "vehiclePlate", order: "asc" }),
    ).toEqual([13, 10, 9, 5, 1, 11, 7, 6, 3, 12, 8, 4, 2]);
    expect(
      await codesOf(repository, { sort: "vehiclePlate", order: "desc" }),
    ).toEqual([12, 8, 4, 2, 11, 7, 6, 3, 13, 10, 9, 5, 1]);
    expect(
      await codesOf(repository, { sort: "started_at", order: "desc" }),
    ).toEqual([13, 6, 10, 12, 1, 9, 11, 8, 7, 4, 5, 3, 2]);
  });

  it("orders the status by the enum's declared order", async () => {
    const repository = await seededBoard();

    const listing = [
      ...(
        await repository.listRoutes({
          businessId: CARRIER,
          page: 1,
          pageSize: 13,
          sort: "status",
          order: "asc",
        })
      ).data,
    ];

    expect(listing.map((route) => route.status)).toEqual([
      "PLANNED",
      "PLANNED",
      "PLANNED",
      "PLANNED",
      "RELEASED",
      "RELEASED",
      "IN_PROGRESS",
      "IN_PROGRESS",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "CANCELLED",
      "CANCELLED",
    ]);
  });

  it("counts the cards and facets with every other filter, never their own", async () => {
    const repository = await seededBoard();

    const byDrivers = await repository.listRoutes({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      driverIds: [ANA, CARLA],
      statuses: ["COMPLETED"],
    });

    expect(byDrivers.data.map((route) => route.code)).toEqual([12, 9, 1]);
    expect(byDrivers.total).toBe(3);
    expect(byDrivers.meta.statusCounts).toEqual({
      PLANNED: 2,
      RELEASED: 1,
      IN_PROGRESS: 2,
      COMPLETED: 3,
      CANCELLED: 1,
    });
    expect(byDrivers.meta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 1 },
      { value: CARLA, label: "Carla", count: 2 },
    ]);

    const byVehicle = await repository.listRoutes({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      vehicleIds: [TRUCK_B],
    });

    expect(byVehicle.meta.facets.vehicleId).toEqual([
      { value: TRUCK_A, label: "AAA1A11", count: 5 },
      { value: TRUCK_B, label: "BBB2B22", count: 4 },
    ]);
  });

  it("never names another company's driver or vehicle, even when selected", async () => {
    const repository = await seededBoard();

    const listing = await repository.listRoutes({
      businessId: CARRIER,
      page: 1,
      pageSize: 10,
      driverIds: [FOREIGN_DRIVER],
      vehicleIds: [FOREIGN_TRUCK],
    });

    expect(listing.total).toBe(0);
    expect(listing.meta.facets.driverId).toEqual([]);
    expect(listing.meta.facets.vehicleId).toEqual([]);
  });

  it("searches the mirrored driver's name and the destination, never the placeholder", async () => {
    const repository = await seededBoard();

    // A driver row the test did not mirror: displayed with the placeholder,
    // which Postgres would never have, so it must not be searchable.
    await repository.createRoute({
      businessId: CARRIER,
      driverId: "drv-not-mirrored",
      scheduled_date: new Date("2026-09-10"),
      deliveryIds: [],
    });

    // Red before: every route hydrated as "Motorista" matched "motor".
    expect(await codesOf(repository, { search: "motor" })).toEqual([]);
    expect(await codesOf(repository, { search: "bruno" })).toEqual([
      11, 8, 5, 2,
    ]);
    expect(
      await codesOf(repository, { search: "cd", statuses: ["PLANNED"] }),
    ).toEqual([8, 3]);

    // The listed rows carry the real names and plates, as the include does.
    const [newest] = (
      await repository.listRoutes({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
        search: "Rota 13",
      })
    ).data;

    expect(newest.driver).toEqual({ id: ANA, name: "Ana" });
    expect(newest.vehicle).toEqual({ id: TRUCK_A, license_plate: "AAA1A11" });
  });

  it("scopes a driver to their own routes", async () => {
    const repository = await seededBoard();

    expect(await codesOf(repository, { scopeDriverId: ANA })).toEqual([
      13, 10, 7, 4, 1,
    ]);
  });
});

describe("the board's pure rules", () => {
  it("drops only the named facet from the where, keeping the tenant on top", () => {
    const where = routeListWhere(
      {
        businessId: CARRIER,
        statuses: ["PLANNED"],
        driverIds: [ANA],
        vehicleIds: [TRUCK_A],
        search: "Rota 12",
      },
      { except: "driverId" },
    );

    expect(where.businessId).toBe(CARRIER);
    expect(JSON.stringify(where)).not.toContain(ANA);
    expect(JSON.stringify(where)).toContain(TRUCK_A);
    expect(JSON.stringify(where)).toContain('"code":12');
  });

  it("does not read a pasted NF-e key as a route number", () => {
    const where = routeListWhere({
      businessId: CARRIER,
      search: "35240912345678000190550010000012341000012345",
    });

    expect(JSON.stringify(where)).not.toContain('"code"');
  });

  it("totals only the statuses the filter keeps and fills the zeros", () => {
    const { total, searchMeta } = summarizeRouteList(
      [
        { value: "PLANNED", count: 4 },
        { value: "COMPLETED", count: 3 },
      ],
      { statuses: ["PLANNED"] },
      { drivers: [], vehicles: [] },
    );

    expect(total).toBe(4);
    expect(searchMeta.statusCounts).toEqual({
      PLANNED: 4,
      RELEASED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 3,
      CANCELLED: 0,
    });
    expect(searchMeta.facets.status.map((entry) => entry.value)).toEqual([
      "PLANNED",
      "RELEASED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ]);
  });

  it("keeps a selected catalog option at zero and drops unnamed ids", () => {
    expect(
      catalogFacetOptions(
        [
          { value: "b", count: 2 },
          { value: null, count: 5 },
          { value: "x", count: 1 },
        ],
        ["a"],
        new Map([
          ["a", "Ana"],
          ["b", "Bruno"],
        ]),
      ),
    ).toEqual([
      { value: "a", label: "Ana", count: 0 },
      { value: "b", label: "Bruno", count: 2 },
    ]);
  });
});
