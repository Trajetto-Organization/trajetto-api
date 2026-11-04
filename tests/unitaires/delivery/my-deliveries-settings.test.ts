import { beforeEach, describe, expect, it } from "vitest";

import { ListMyDeliveriesUseCase } from "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase";
import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryDriverPauseRepository } from "@/modules/driver-pause/repositories/in-memory/in-memory-driver-pause-repository";
import { InMemoryBusinessSettingsRepository } from "@/modules/business/repositories/in-memory/in-memory-business-settings-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import type { VehicleChecklist } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The driver's payload of the plan of 02/11/2026 (C2, C4, M1, M6): what the
 * app's 7-day offline cache needs to draw "Minhas rotas" and to hold
 * "Iniciar rota" until the departure checklist — the company's settings with
 * the module rule applied, each route's vehicle, and each route's checklist
 * status derived from the checklists made for it (never stored on the route).
 * The SQL half (the vehicle select, the checklist read) is in
 * tests/E2E/business-settings-http.test.ts.
 */
const BUSINESS = "018f5b00-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f5b00-0000-7000-8000-00000000000c";
const DRIVER_USER = "018f5b00-0000-7000-8000-0000000000a1";
const DRIVER = "018f5b00-0000-7000-8000-0000000000d1";
const ROUTE_1 = "018f5b00-0000-7000-8000-0000000000e1";
const ROUTE_2 = "018f5b00-0000-7000-8000-0000000000e2";
const VEHICLE = "018f5b00-0000-7000-8000-0000000000c1";

let users: InMemoryUserRepository;
let settings: InMemoryBusinessSettingsRepository;
let checklists: InMemoryVehicleChecklistRepository;

/** The worklist as the Prisma read returns it: each open stop with its route. */
const worklist = [
  {
    id: "delivery-1",
    stops: [
      {
        id: "stop-1",
        sequence: 10,
        route: {
          id: ROUTE_1,
          code: 1,
          plan_version: 3,
          vehicle: { id: VEHICLE, license_plate: "ABC1D23" },
        },
      },
    ],
  },
  {
    id: "delivery-2",
    stops: [
      {
        id: "stop-2",
        sequence: 20,
        route: { id: ROUTE_1, code: 1, plan_version: 3 },
      },
    ],
  },
  {
    id: "delivery-3",
    stops: [
      {
        id: "stop-3",
        sequence: 10,
        route: { id: ROUTE_2, code: 2, plan_version: 0, vehicle: null },
      },
    ],
  },
];

const deliveries = {
  listDriverDeliveries: async () => structuredClone(worklist),
} as unknown as IDeliveryRepository;

function checklist(
  id: string,
  overrides: Partial<VehicleChecklist>,
): VehicleChecklist {
  return {
    id,
    businessId: BUSINESS,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    branchId: "branch",
    overall_condition: "approved",
    checklist_date: new Date("2026-11-02T08:00:00.000Z"),
    phase: "STANDALONE",
    routeId: null,
    ...overrides,
  } as VehicleChecklist;
}

function useCase() {
  return new ListMyDeliveriesUseCase(
    users,
    deliveries,
    new InMemoryOccurrenceTypeRepository(),
    new InMemoryDriverPauseRepository(
      [],
      [],
      [],
      [{ id: BUSINESS, timezone: "America/Sao_Paulo" }],
    ),
    settings,
    checklists,
  );
}

function driverWithModules(modules: string[]): void {
  users.user[0].business = {
    is_active: true,
    entitlements: modules.map((module) => ({ module, enabled: true })),
  };
}

beforeEach(() => {
  users = new InMemoryUserRepository();
  settings = new InMemoryBusinessSettingsRepository();
  checklists = new InMemoryVehicleChecklistRepository();

  users.user.push({
    id: DRIVER_USER,
    name: "João Motorista",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER,
    email: "joao@alfa.com.br",
  } as User);

  driverWithModules(["FLEET", "DELIVERIES"]);
});

describe("my-deliveries: the company's settings", () => {
  it("carries the defaults for a company that never saved", async () => {
    const result = await useCase().execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    expect(result.settings).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
    });
  });

  it("carries the saved values, and no route checklist without the fleet (M6)", async () => {
    await settings.save({
      businessId: BUSINESS,
      updatedById: "admin",
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "ALERT",
      arrival_geofence_radius_m: 300,
    });

    expect(
      (await useCase().execute({ userId: DRIVER_USER, businessId: BUSINESS }))
        .settings,
    ).toEqual({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "ALERT",
      arrival_geofence_radius_m: 300,
    });

    driverWithModules(["DELIVERIES"]);

    expect(
      (await useCase().execute({ userId: DRIVER_USER, businessId: BUSINESS }))
        .settings,
    ).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "ALERT",
      arrival_geofence_radius_m: 300,
    });
  });

  it("never reads another company's settings", async () => {
    await settings.save({
      businessId: OTHER_BUSINESS,
      updatedById: "admin",
      arrival_geofence_mode: "BLOCK",
    });

    expect(
      (await useCase().execute({ userId: DRIVER_USER, businessId: BUSINESS }))
        .settings.arrival_geofence_mode,
    ).toBe("DISABLED");
  });
});

describe("my-deliveries: each route's vehicle and checklist status", () => {
  it("lists each route once, with its plate, or null without a vehicle", async () => {
    const { routes } = await useCase().execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    expect(routes.map((route) => [route.id, route.vehicle])).toEqual([
      [ROUTE_1, { id: VEHICLE, license_plate: "ABC1D23" }],
      [ROUTE_2, null],
    ]);
  });

  it("derives the departure and arrival checklists from the rows made for the route", async () => {
    checklists.checklists.push(
      checklist("start-old", {
        routeId: ROUTE_1,
        phase: "ROUTE_START",
        checklist_date: new Date("2026-11-02T07:00:00.000Z"),
        overall_condition: "rejected",
      }),
      checklist("start-new", {
        routeId: ROUTE_1,
        phase: "ROUTE_START",
        checklist_date: new Date("2026-11-02T07:30:00.000Z"),
      }),
      // Made outside the route: never counts as the route's.
      checklist("standalone", {
        routeId: ROUTE_1,
        phase: "STANDALONE",
        checklist_date: new Date("2026-11-02T09:00:00.000Z"),
      }),
      // Another company's row naming the same route id: never read.
      checklist("foreign-end", {
        businessId: OTHER_BUSINESS,
        routeId: ROUTE_1,
        phase: "ROUTE_END",
      }),
      checklist("end-route-2", {
        routeId: ROUTE_2,
        phase: "ROUTE_END",
        overall_condition: "approved_with_restrictions",
      }),
    );

    const { routes } = await useCase().execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    const byId = new Map(routes.map((route) => [route.id, route.checklists]));

    expect(byId.get(ROUTE_1)).toEqual({
      route_start: {
        id: "start-new",
        checklist_date: new Date("2026-11-02T07:30:00.000Z"),
        overall_condition: "approved",
      },
      route_end: null,
    });
    expect(byId.get(ROUTE_2)).toEqual({
      route_start: null,
      route_end: {
        id: "end-route-2",
        checklist_date: new Date("2026-11-02T08:00:00.000Z"),
        overall_condition: "approved_with_restrictions",
      },
    });
  });

  it("answers both moments as pending when nothing was made for the route", async () => {
    const { routes } = await useCase().execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
    });

    for (const route of routes) {
      expect(route.checklists).toEqual({ route_start: null, route_end: null });
    }
  });
});

describe("my-deliveries: a route still owing its arrival checklist (C4)", () => {
  const ENDED_ROUTE = "018f5b00-0000-7000-8000-0000000000e9";
  const NOW = new Date("2026-11-03T15:00:00.000Z");

  function endedRoute(overrides: Partial<{ completed_at: Date }> = {}) {
    checklists.routes.push({
      id: ENDED_ROUTE,
      code: 9,
      plan_version: 4,
      vehicle: { id: VEHICLE, license_plate: "ABC1D23" },
      businessId: BUSINESS,
      driverId: DRIVER,
      status: "COMPLETED",
      completed_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      ...overrides,
    });
  }

  async function routes() {
    return (
      await useCase().execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        now: NOW,
      })
    ).routes;
  }

  async function requireOnArrival(
    requirement: "ROUTE_END" | "ROUTE_START_AND_END" = "ROUTE_END",
  ) {
    await settings.save({
      businessId: BUSINESS,
      updatedById: "admin",
      checklist_requirement: requirement,
    });
  }

  it("keeps a route that ended without it, after the open ones, until it is done", async () => {
    // The last stop resolved, so the route has no open stop left in the
    // worklist: without this the app lost the route it still had to close.
    await requireOnArrival("ROUTE_START_AND_END");
    endedRoute();
    checklists.checklists.push(
      checklist("start-ended", { routeId: ENDED_ROUTE, phase: "ROUTE_START" }),
    );

    const listed = await routes();

    expect(listed.map((route) => [route.id, route.completed_at])).toEqual([
      [ROUTE_1, null],
      [ROUTE_2, null],
      [ENDED_ROUTE, new Date(NOW.getTime() - 2 * 60 * 60 * 1000)],
    ]);
    expect(listed[2]).toMatchObject({
      code: 9,
      plan_version: 4,
      vehicle: { id: VEHICLE, license_plate: "ABC1D23" },
      checklists: {
        route_start: { id: "start-ended" },
        route_end: null,
      },
    });

    checklists.checklists.push(
      checklist("end-ended", { routeId: ENDED_ROUTE, phase: "ROUTE_END" }),
    );

    expect((await routes()).map((route) => route.id)).not.toContain(
      ENDED_ROUTE,
    );
  });

  it("lets the route go when the company does not ask for it on arrival", async () => {
    endedRoute();

    expect((await routes()).map((route) => route.id)).not.toContain(
      ENDED_ROUTE,
    );

    await settings.save({
      businessId: BUSINESS,
      updatedById: "admin",
      checklist_requirement: "ROUTE_START",
    });

    expect((await routes()).map((route) => route.id)).not.toContain(
      ENDED_ROUTE,
    );
  });

  it("lets the route go a day after it ended, and without the fleet (M6)", async () => {
    await requireOnArrival();
    endedRoute({
      completed_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
    });

    expect((await routes()).map((route) => route.id)).not.toContain(
      ENDED_ROUTE,
    );

    checklists.routes.length = 0;
    endedRoute();
    driverWithModules(["DELIVERIES"]);

    expect((await routes()).map((route) => route.id)).not.toContain(
      ENDED_ROUTE,
    );
  });
});
