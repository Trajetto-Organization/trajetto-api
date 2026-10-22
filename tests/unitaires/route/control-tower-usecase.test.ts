import { beforeEach, describe, expect, it } from "vitest";

import { ControlTowerUseCase } from "@/modules/route/usecases/control-tower/control-tower-usecase";
import { DriverTrailUseCase } from "@/modules/route/usecases/driver-trail/driver-trail-usecase";
import { RouteMonitoringUseCase } from "@/modules/route/usecases/route-monitoring/route-monitoring-usecase";
import { DriverMonitoringUseCase } from "@/modules/route/usecases/driver-monitoring/driver-monitoring-usecase";

import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import {
  InMemoryOperationDayRepository,
  type OperationRows,
} from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";

/**
 * The tower's day is the COMPANY's day, whatever the server's clock says.
 *
 * The clock is fixed at 22:00 in São Paulo (01:00 UTC of the next day), the
 * hour the old code had already rolled "hoje" over: the process runs in UTC,
 * and `setHours(0, 0, 0, 0)` meant the UTC midnight. The same instant is
 * 20:00 in Rio Branco, so a second company in that zone proves the day comes
 * from `Business.timezone`, not from a constant.
 */
const NOW = new Date("2026-09-18T01:00:00.000Z");

const SP = "018f0000-0000-7000-8000-00000000a001";
const ACRE = "018f0000-0000-7000-8000-00000000a002";

const MANAGER = {
  id: "manager",
  businessId: SP,
  role: "BUSINESS_ADMIN",
  driverId: null,
};
const ACRE_MANAGER = {
  id: "acre",
  businessId: ACRE,
  role: "BUSINESS_ADMIN",
  driverId: null,
};
const MASTER = {
  id: "master",
  businessId: null,
  role: "MASTER",
  driverId: null,
};
const DRIVER_USER = {
  id: "driver-user",
  businessId: SP,
  role: "BUSINESS_USER",
  driverId: "d1",
};

const users = [MANAGER, ACRE_MANAGER, MASTER, DRIVER_USER];

const userRepository = {
  findUserById: async (id: string) =>
    users.find((user) => user.id === id) ?? null,
} as never;

const at = (iso: string) => new Date(iso);
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

let operation: InMemoryOperationDayRepository;
let positions: InMemoryDriverPositionRepository;

function route(
  overrides: Partial<OperationRows["routes"][number]> & {
    id: string;
    driverId: string;
  },
): OperationRows["routes"][number] {
  return {
    businessId: SP,
    code: Number(overrides.id.replace(/\D/g, "")) || 1,
    name: null,
    destination: null,
    status: "PLANNED",
    scheduled_date: day("2026-09-17"),
    planned_departure_at: null,
    started_at: null,
    completed_at: null,
    updated_at: NOW,
    vehicleId: null,
    ...overrides,
  };
}

function delivery(
  overrides: Partial<OperationRows["deliveries"][number]> & { id: string },
): OperationRows["deliveries"][number] {
  return {
    businessId: SP,
    status: "PENDING",
    driverId: null,
    recipient_name: `Cliente ${overrides.id}`,
    city: "São Paulo",
    delivered_at: null,
    updated_at: at("2026-09-17T12:00:00.000Z"),
    ...overrides,
  };
}

function stop(
  id: string,
  routeId: string,
  deliveryId: string,
  status = "PENDING",
  sequence = 1,
): OperationRows["stops"][number] {
  return {
    id,
    routeId,
    deliveryId,
    sequence,
    status,
    on_the_way_at: null,
    arrived_at: null,
    completed_at:
      status === "FAILED" || status === "COMPLETED"
        ? at("2026-09-17T18:00:00.000Z")
        : null,
    updated_at: at("2026-09-17T18:00:00.000Z"),
  };
}

beforeEach(() => {
  operation = new InMemoryOperationDayRepository();
  positions = new InMemoryDriverPositionRepository();

  operation.rows.businesses.push(
    { id: SP, timezone: "America/Sao_Paulo" },
    { id: ACRE, timezone: "America/Rio_Branco" },
  );

  operation.rows.drivers.push(
    { id: "d1", businessId: SP, name: "Ana" },
    { id: "d2", businessId: SP, name: "Bruno" },
    { id: "d3", businessId: SP, name: "Carla" },
    { id: "d4", businessId: SP, name: "Davi" },
  );
  positions.drivers.push(...operation.rows.drivers);

  operation.rows.vehicles.push({ id: "v1", license_plate: "ABC1D23" });

  operation.rows.occurrenceTypes.push(
    { id: "absent", name: "Cliente ausente", blocks_delivery: true },
    { id: "late", name: "Atraso no portão", blocks_delivery: false },
  );
});

const tower = () =>
  new ControlTowerUseCase(userRepository, positions, operation);

describe("the funnel counts the documents active in the company's day (TWR-1/TWR-2)", () => {
  beforeEach(() => {
    operation.rows.routes.push(
      route({ id: "r1", driverId: "d1", status: "RELEASED" }),
      route({ id: "r2", driverId: "d2", scheduled_date: day("2026-09-18") }),
    );

    operation.rows.deliveries.push(
      // Delivered at 09:00 in São Paulo on the 17th. After 21:00 the UTC day
      // is already the 18th and the old counters had dropped it.
      delivery({
        id: "morning",
        status: "DELIVERED",
        delivered_at: at("2026-09-17T12:00:00.000Z"),
      }),
      // 23:00 on the 16th: yesterday.
      delivery({
        id: "yesterday",
        status: "DELIVERED",
        delivered_at: at("2026-09-17T02:00:00.000Z"),
      }),
      // Imported last week, out with a driver now: "Em rota" is now.
      delivery({ id: "out", status: "IN_TRANSIT", driverId: "d1" }),
      // On today's route, not out yet.
      delivery({ id: "loaded", status: "PENDING", driverId: "d1" }),
      // The backlog: no route today, not counted as today's work.
      delivery({ id: "backlog", status: "PENDING" }),
      // On tomorrow's route.
      delivery({ id: "tomorrow", status: "PENDING", driverId: "d2" }),
      // Failed today on the street.
      delivery({
        id: "refused",
        status: "FAILED",
        updated_at: at("2026-09-17T20:00:00.000Z"),
      }),
      // Failed on the 16th, address edited today (DLV-MON-2).
      delivery({
        id: "edited",
        status: "FAILED",
        updated_at: at("2026-09-17T21:00:00.000Z"),
      }),
      // Cancelled from the panel today.
      delivery({
        id: "cancelled",
        status: "CANCELLED",
        updated_at: at("2026-09-17T15:00:00.000Z"),
      }),
    );

    operation.rows.stops.push(
      stop("s1", "r1", "loaded"),
      stop("s2", "r2", "tomorrow"),
    );

    operation.rows.occurrences.push(
      {
        id: "o1",
        businessId: SP,
        deliveryId: "refused",
        occurrenceTypeId: "absent",
        authorization_status: "NOT_REQUIRED",
        occurred_at: at("2026-09-17T19:30:00.000Z"),
        created_at: at("2026-09-17T19:31:00.000Z"),
      },
      {
        id: "o2",
        businessId: SP,
        deliveryId: "edited",
        occurrenceTypeId: "absent",
        authorization_status: "NOT_REQUIRED",
        occurred_at: at("2026-09-16T15:00:00.000Z"),
        created_at: at("2026-09-16T15:00:05.000Z"),
      },
    );

    operation.rows.events.push({
      id: "e1",
      businessId: SP,
      deliveryId: "cancelled",
      routeId: null,
      occurrenceId: null,
      type: "STATUS_CHANGE",
      actor: "USER",
      status_to: "CANCELLED",
      occurred_at: null,
      created_at: at("2026-09-17T15:00:00.000Z"),
    });
  });

  it("counts by the São Paulo day at 22:00, not by the UTC one", async () => {
    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    const totals = Object.fromEntries(
      result.funnel.map((entry) => [entry.status, entry.total]),
    );

    expect(result.day).toBe("2026-09-17");
    expect(totals).toEqual({
      PENDING: 1,
      IN_TRANSIT: 1,
      DELIVERED: 1,
      FAILED: 1,
      CANCELLED: 1,
    });

    // "Finalizadas hoje": delivered + failed + cancelled resolved in the day.
    expect(result.progress).toEqual({ finished: 3, total: 5, rate: 60 });
  });

  it("reads another company's day in its own zone", async () => {
    operation.rows.deliveries.push(
      // 23:30 on the 16th in Rio Branco, 01:30 on the 17th in São Paulo.
      delivery({
        id: "acre-late",
        businessId: ACRE,
        status: "DELIVERED",
        delivered_at: at("2026-09-17T04:30:00.000Z"),
      }),
      // 00:30 on the 17th in Rio Branco.
      delivery({
        id: "acre-early",
        businessId: ACRE,
        status: "DELIVERED",
        delivered_at: at("2026-09-17T05:30:00.000Z"),
      }),
    );

    const acre = await tower().execute({ userId: ACRE_MANAGER.id, now: NOW });

    expect(acre.timeZone).toBe("America/Rio_Branco");
    expect(
      acre.funnel.find((entry) => entry.status === "DELIVERED")?.total,
    ).toBe(1);

    // And not a single one of São Paulo's documents.
    expect(acre.progress.total).toBe(1);
  });
});

describe("punctuality is judged at 'now', on today's routes only (TWR-3/TWR-4)", () => {
  it("does not call tomorrow's route or a later departure 'não saiu'", async () => {
    operation.rows.routes.push(
      // Planned for 21:30 today: at 22:00 it is late and still in the yard.
      route({
        id: "r1",
        driverId: "d1",
        status: "RELEASED",
        planned_departure_at: at("2026-09-18T00:30:00.000Z"),
      }),
      // Planned for 23:30 today: not yet.
      route({
        id: "r2",
        driverId: "d2",
        status: "RELEASED",
        planned_departure_at: at("2026-09-18T02:30:00.000Z"),
      }),
      // Tomorrow at 08:00: not today's plan at all.
      route({
        id: "r3",
        driverId: "d3",
        status: "RELEASED",
        scheduled_date: day("2026-09-18"),
        planned_departure_at: at("2026-09-18T11:00:00.000Z"),
      }),
      // Left on time at 20:05 for a 20:00 plan.
      route({
        id: "r4",
        driverId: "d4",
        status: "IN_PROGRESS",
        planned_departure_at: at("2026-09-17T23:00:00.000Z"),
        started_at: at("2026-09-17T23:05:00.000Z"),
      }),
    );

    const { punctuality } = await tower().execute({
      userId: MANAGER.id,
      now: NOW,
    });

    expect(punctuality).toEqual({
      onTime: 1,
      late: 0,
      notDeparted: 1,
      waiting: 1,
      notPlanned: 0,
      rate: 50,
    });
  });
});

describe("the map and the routes on the street (TWR-8/TWR-9)", () => {
  beforeEach(() => {
    operation.rows.routes.push(
      route({
        id: "r1",
        driverId: "d1",
        status: "IN_PROGRESS",
        started_at: at("2026-09-17T23:00:00.000Z"),
        vehicleId: "v1",
      }),
      route({
        id: "r2",
        driverId: "d2",
        status: "IN_PROGRESS",
        started_at: at("2026-09-17T22:00:00.000Z"),
      }),
      route({
        id: "r3",
        driverId: "d3",
        status: "COMPLETED",
        completed_at: at("2026-09-18T00:00:00.000Z"),
      }),
      route({
        id: "r4",
        driverId: "d4",
        status: "COMPLETED",
        completed_at: at("2026-09-17T22:00:00.000Z"),
      }),
    );

    operation.rows.deliveries.push(
      delivery({
        id: "a",
        status: "DELIVERED",
        delivered_at: at("2026-09-17T23:30:00.000Z"),
      }),
      delivery({ id: "b", status: "IN_TRANSIT" }),
    );
    operation.rows.stops.push(
      stop("s1", "r1", "a", "COMPLETED", 1),
      stop("s2", "r1", "b", "PENDING", 2),
    );

    const point = (driverId: string, routeId: string, minutesAgo: number) => ({
      driverId,
      businessId: SP,
      routeId,
      latitude: -23.5,
      longitude: -46.6,
      accuracy: 10,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: new Date(NOW.getTime() - minutesAgo * 60_000),
    });

    positions.last.set("d1", point("d1", "r1", 2));
    positions.last.set("d3", point("d3", "r3", 65));
    positions.last.set("d4", point("d4", "r4", 185));
  });

  it("draws running trucks, finished ones for two hours, and nothing older", async () => {
    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    const byDriver = Object.fromEntries(
      result.positions.map((position) => [position.driverId, position]),
    );

    expect(byDriver.d1).toMatchObject({
      state: "moving",
      fresh: true,
      vehiclePlate: "ABC1D23",
      routeStatus: "IN_PROGRESS",
    });

    // Ended an hour ago: its own look, not "sem reportar".
    expect(byDriver.d3).toMatchObject({
      state: "ended",
      fresh: false,
      routeStatus: "COMPLETED",
    });
    expect(byDriver.d3.endedAt).toBe("2026-09-18T00:00:00.000Z");

    // Ended three hours ago: off the map.
    expect(byDriver.d4).toBeUndefined();
  });

  it("marks a truck on a running route whose driver has an open pause, and only that one", async () => {
    operation.rows.pauses = [
      {
        driverId: "d1",
        businessId: SP,
        started_at: at("2026-09-18T00:40:00.000Z"),
        ended_at: null,
      },
      // A finished route's driver on a break is not the tower's business.
      {
        driverId: "d3",
        businessId: SP,
        started_at: at("2026-09-18T00:30:00.000Z"),
        ended_at: null,
      },
      // A closed pause, and another company's open one, change nothing.
      {
        driverId: "d1",
        businessId: SP,
        started_at: at("2026-09-17T23:10:00.000Z"),
        ended_at: at("2026-09-17T23:20:00.000Z"),
      },
      {
        driverId: "d1",
        businessId: ACRE,
        started_at: at("2026-09-18T00:45:00.000Z"),
        ended_at: null,
      },
    ];

    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    const byDriver = Object.fromEntries(
      result.positions.map((position) => [position.driverId, position]),
    );

    expect(byDriver.d1).toMatchObject({
      state: "moving",
      pausedSince: "2026-09-18T00:40:00.000Z",
    });
    expect(byDriver.d3).toMatchObject({ state: "ended", pausedSince: null });
  });

  it("lists a running route with no position, with its progress", async () => {
    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    const silent = result.activeRoutes.find((entry) => entry.routeId === "r2");
    const moving = result.activeRoutes.find((entry) => entry.routeId === "r1");

    expect(silent).toMatchObject({ driverName: "Bruno", lastSignalAt: null });
    expect(moving).toMatchObject({ progress: { resolved: 1, total: 2 } });
    expect(result.activeRoutes).toHaveLength(2);
  });

  it("keeps the last signal of a running route whose phone went quiet before the map's window", async () => {
    // Bruno's route runs since yesterday and his phone last reported 14 h
    // ago: off the 12 h map, but not "sem posição desde a saída".
    const quietSince = new Date(NOW.getTime() - 14 * 60 * 60_000);

    positions.last.set("d2", {
      driverId: "d2",
      businessId: SP,
      routeId: "r2",
      latitude: -23.5,
      longitude: -46.6,
      accuracy: 10,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: quietSince,
    });

    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    expect(
      result.positions.find((position) => position.driverId === "d2"),
    ).toBeUndefined();
    expect(
      result.activeRoutes.find((entry) => entry.routeId === "r2")?.lastSignalAt,
    ).toBe(quietSince.toISOString());
  });

  it("never reads another company's last signal", async () => {
    positions.last.set("d2", {
      driverId: "d2",
      businessId: ACRE,
      routeId: null,
      latitude: -9.9,
      longitude: -67.8,
      accuracy: 10,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: new Date(NOW.getTime() - 14 * 60 * 60_000),
    });

    const result = await tower().execute({ userId: MANAGER.id, now: NOW });

    expect(
      result.activeRoutes.find((entry) => entry.routeId === "r2")?.lastSignalAt,
    ).toBeNull();
  });
});

describe("the feed shows occurrences, failures and routes of the day (TWR-6/TWR-7)", () => {
  it("lists what happened today, newest first, and nothing from yesterday", async () => {
    operation.rows.routes.push(
      route({
        id: "r1",
        driverId: "d1",
        status: "IN_PROGRESS",
        started_at: at("2026-09-17T11:00:00.000Z"),
      }),
      route({
        id: "r2",
        driverId: "d2",
        status: "CANCELLED",
        started_at: at("2026-09-17T10:00:00.000Z"),
        updated_at: at("2026-09-17T13:00:00.000Z"),
      }),
    );

    operation.rows.deliveries.push(
      delivery({ id: "refused", status: "FAILED", driverId: "d1" }),
      delivery({ id: "old", status: "DELIVERED", driverId: "d1" }),
    );

    operation.rows.occurrences.push({
      id: "o1",
      businessId: SP,
      deliveryId: "refused",
      occurrenceTypeId: "absent",
      authorization_status: "NOT_REQUIRED",
      occurred_at: at("2026-09-17T14:00:00.000Z"),
      created_at: at("2026-09-17T14:00:02.000Z"),
    });

    operation.rows.events.push({
      id: "e-yesterday",
      businessId: SP,
      deliveryId: "old",
      routeId: null,
      occurrenceId: null,
      type: "PROOF",
      actor: "DRIVER_APP",
      status_to: null,
      occurred_at: null,
      created_at: at("2026-09-17T02:00:00.000Z"),
    });

    const { events } = await tower().execute({ userId: MANAGER.id, now: NOW });

    expect(events.map((event) => event.type)).toEqual([
      "OCCURRENCE",
      "ROUTE_CANCELLED",
      "ROUTE_STARTED",
      "ROUTE_STARTED",
    ]);

    expect(events[0]).toMatchObject({
      deliveryId: "refused",
      detail: "Cliente ausente",
      failure: true,
      driverName: "Ana",
      occurredAt: "2026-09-17T14:00:00.000Z",
    });
  });
});

describe("who may open the tower", () => {
  it("refuses a driver token", async () => {
    await expect(
      tower().execute({ userId: DRIVER_USER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses another company's id to a company user", async () => {
    await expect(
      tower().execute({ userId: MANAGER.id, businessId: ACRE, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("asks a MASTER which company", async () => {
    await expect(
      tower().execute({ userId: MASTER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });

    const result = await tower().execute({
      userId: MASTER.id,
      businessId: ACRE,
      now: NOW,
    });

    expect(result.timeZone).toBe("America/Rio_Branco");
  });
});

describe("the trail's day is the company's day", () => {
  const trail = () =>
    new DriverTrailUseCase(
      userRepository,
      positions,
      operation,
      new InMemoryRouteRepository(),
    );

  beforeEach(() => {
    const point = (iso: string) => ({
      driverId: "d1",
      businessId: SP,
      routeId: null,
      latitude: -23.5,
      longitude: -46.6,
      accuracy: 10,
      speed: 20,
      heading: null,
      battery: null,
      recorded_at: at(iso),
    });

    positions.trail.push(
      // 08:00 and 22:30 in São Paulo on the 17th: two UTC days, one working day.
      point("2026-09-17T11:00:00.000Z"),
      point("2026-09-18T01:30:00.000Z"),
      // 23:59 on the 16th, and midnight of the 18th: neither is the 17th.
      point("2026-09-17T02:59:00.000Z"),
      point("2026-09-18T03:00:00.000Z"),
    );
  });

  it("keeps the morning and the late evening in the same day at 22:00", async () => {
    const result = await trail().execute({
      userId: MANAGER.id,
      driverId: "d1",
      now: NOW,
    });

    expect(result.day).toBe("2026-09-17");
    expect(result.recorded).toBe(2);
  });

  it("reads an explicit day in the company's zone, half-open at midnight", async () => {
    const result = await trail().execute({
      userId: MANAGER.id,
      driverId: "d1",
      day: "2026-09-18",
      now: NOW,
    });

    expect(result.recorded).toBe(1);
  });

  it("answers the same 404 for another company's driver", async () => {
    await expect(
      trail().execute({ userId: ACRE_MANAGER.id, driverId: "d1", now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a day that does not exist", async () => {
    await expect(
      trail().execute({
        userId: MANAGER.id,
        driverId: "d1",
        day: "2026-02-30",
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("the monitoring board by route (DLVP-MON-1)", () => {
  const board = () => new RouteMonitoringUseCase(userRepository, operation);

  beforeEach(() => {
    operation.rows.routes.push(
      route({
        id: "r1",
        driverId: "d1",
        status: "COMPLETED",
        completed_at: at("2026-09-17T20:00:00.000Z"),
      }),
      route({
        id: "r2",
        driverId: "d2",
        status: "IN_PROGRESS",
        started_at: at("2026-09-17T12:00:00.000Z"),
      }),
      // Yesterday's route still running: today's board has it.
      route({
        id: "r3",
        driverId: "d3",
        status: "IN_PROGRESS",
        scheduled_date: day("2026-09-16"),
      }),
      route({ id: "r4", driverId: "d4", status: "CANCELLED" }),
      route({
        id: "r5",
        driverId: "d4",
        status: "PLANNED",
        scheduled_date: day("2026-09-18"),
      }),
    );

    operation.rows.deliveries.push(
      delivery({ id: "a" }),
      delivery({ id: "b" }),
      delivery({ id: "c" }),
    );

    operation.rows.stops.push(
      stop("s1", "r2", "a", "COMPLETED", 1),
      stop("s2", "r2", "b", "FAILED", 2),
      stop("s3", "r2", "c", "PENDING", 3),
    );
  });

  it("lists today's routes, running first, with one entry per stop", async () => {
    const result = await board().execute({
      userId: MANAGER.id,
      page: 1,
      pageSize: 20,
      now: NOW,
    });

    expect(result.routes.map((entry) => entry.id)).toEqual(["r2", "r3", "r1"]);
    expect(result.meta.total).toBe(3);

    const running = result.routes[0];

    expect(running.stops.map((entry) => entry.status)).toEqual([
      "COMPLETED",
      "FAILED",
      "PENDING",
    ]);
    expect(running.progress).toMatchObject({
      completion: 66.7,
      deliveredRate: 33.3,
    });
    expect(running.scheduledDate).toBe("2026-09-17");
  });

  it("pages without losing the total", async () => {
    const result = await board().execute({
      userId: MANAGER.id,
      page: 2,
      pageSize: 2,
      now: NOW,
    });

    expect(result.routes.map((entry) => entry.id)).toEqual(["r1"]);
    expect(result.meta).toEqual({ total: 3, page: 2, pageSize: 2 });
  });

  it("refuses a driver token", async () => {
    await expect(
      board().execute({
        userId: DRIVER_USER.id,
        page: 1,
        pageSize: 20,
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a company user naming another company, and shows them nothing of it", async () => {
    await expect(
      board().execute({
        userId: ACRE_MANAGER.id,
        businessId: SP,
        page: 1,
        pageSize: 20,
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    // Their own board is their own company's: none of São Paulo's routes.
    const own = await board().execute({
      userId: ACRE_MANAGER.id,
      page: 1,
      pageSize: 20,
      now: NOW,
    });

    expect(own.routes).toEqual([]);
    expect(own.meta.total).toBe(0);
  });

  it("asks a MASTER which company, then reads the one named", async () => {
    await expect(
      board().execute({ userId: MASTER.id, page: 1, pageSize: 20, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const named = await board().execute({
      userId: MASTER.id,
      businessId: SP,
      page: 1,
      pageSize: 20,
      now: NOW,
    });

    expect(named.meta.total).toBe(3);
  });

  it("answers a session user who no longer exists with 404 USER_NOT_FOUND", async () => {
    await expect(
      board().execute({ userId: "gone", page: 1, pageSize: 20, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });

  it("returns an empty page past the last one, keeping the total", async () => {
    const result = await board().execute({
      userId: MANAGER.id,
      page: 9,
      pageSize: 2,
      now: NOW,
    });

    expect(result.routes).toEqual([]);
    expect(result.meta.total).toBe(3);
  });
});

describe("the monitoring board by driver reads the tower's day (decision 7.1, DLV-MON-3)", () => {
  const board = () => new DriverMonitoringUseCase(userRepository, operation);

  beforeEach(() => {
    operation.rows.drivers.find((driver) => driver.id === "d1")!.cnh =
      "12345678900";

    operation.rows.routes.push(
      route({
        id: "r1",
        driverId: "d1",
        status: "IN_PROGRESS",
        started_at: at("2026-09-17T12:00:00.000Z"),
      }),
      route({ id: "r2", driverId: "d2", status: "RELEASED" }),
      // Tomorrow's route: not today's load.
      route({ id: "r3", driverId: "d2", scheduled_date: day("2026-09-18") }),
    );

    operation.rows.deliveries.push(
      delivery({
        id: "a",
        status: "DELIVERED",
        driverId: "d1",
        delivered_at: at("2026-09-17T13:00:00.000Z"),
      }),
      delivery({
        id: "b",
        status: "FAILED",
        driverId: "d1",
        updated_at: at("2026-09-17T14:00:00.000Z"),
      }),
      delivery({ id: "c", status: "IN_TRANSIT", driverId: "d1" }),
      delivery({ id: "d", status: "PENDING", driverId: "d2" }),
      delivery({ id: "e", status: "PENDING", driverId: "d2" }),
      // Another company's driver id never shows up here.
      delivery({
        id: "x",
        businessId: ACRE,
        status: "IN_TRANSIT",
        driverId: "d9",
      }),
    );

    operation.rows.stops.push(
      stop("s1", "r1", "a", "COMPLETED", 1),
      stop("s2", "r1", "b", "FAILED", 2),
      stop("s3", "r1", "c", "PENDING", 3),
      stop("s4", "r2", "d", "PENDING", 1),
      stop("s5", "r3", "e", "PENDING", 1),
    );
  });

  it("splits the day's active documents by driver, without tomorrow's load", async () => {
    const result = await board().execute({ userId: MANAGER.id, now: NOW });

    expect(result).toMatchObject({
      day: "2026-09-17",
      timeZone: "America/Sao_Paulo",
    });

    expect(result.drivers).toEqual([
      // On the street first.
      {
        driverId: "d1",
        driverName: "Ana",
        cnh: "12345678900",
        designated: 0,
        inRoute: 1,
        deliveredToday: 1,
        failedToday: 1,
      },
      // e is on tomorrow's route: one designada, not two.
      {
        driverId: "d2",
        driverName: "Bruno",
        cnh: "",
        designated: 1,
        inRoute: 0,
        deliveredToday: 0,
        failedToday: 0,
      },
    ]);
  });

  it("adds up to the tower's funnel for the documents with a driver", async () => {
    const [drivers, tower] = await Promise.all([
      board().execute({ userId: MANAGER.id, now: NOW }),
      new ControlTowerUseCase(userRepository, positions, operation).execute({
        userId: MANAGER.id,
        now: NOW,
      }),
    ]);

    const funnel = Object.fromEntries(
      tower.funnel.map((entry) => [entry.status, entry.total]),
    );
    const sum = (
      key: "designated" | "inRoute" | "deliveredToday" | "failedToday",
    ) => drivers.drivers.reduce((total, row) => total + row[key], 0);

    expect([
      sum("designated"),
      sum("inRoute"),
      sum("deliveredToday"),
      sum("failedToday"),
    ]).toEqual([
      funnel.PENDING,
      funnel.IN_TRANSIT,
      funnel.DELIVERED,
      funnel.FAILED,
    ]);
  });

  it("refuses a driver token and another company's id", async () => {
    await expect(
      board().execute({ userId: DRIVER_USER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });

    await expect(
      board().execute({ userId: MANAGER.id, businessId: ACRE, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("asks a MASTER which company, and refuses a day that does not exist", async () => {
    await expect(
      board().execute({ userId: MASTER.id, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(
      board().execute({ userId: MANAGER.id, day: "2026-02-30", now: NOW }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
