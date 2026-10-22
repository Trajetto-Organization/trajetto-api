import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import {
  InMemoryOperationDayRepository,
  type OperationRows,
} from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import type {
  FeedEntry,
  IOperationDayRepository,
  OperationDay,
} from "@/modules/route/repositories/IOperation-day-repository";
import { operationDay } from "@/shared/route/operation-day-rules";

/**
 * The one definition of "the operation of the day" (decision 7.1), run
 * against Postgres and against its in-memory twin (decision 13.2).
 *
 * One scenario, seeded in both, with a company in Rio Branco (UTC-5): its
 * day starts at 05:00 UTC, which neither a UTC container nor a São Paulo
 * laptop would guess. Every expectation is written out by hand first — two
 * implementations agreeing on a wrong answer would otherwise pass — and then
 * the two are compared field by field.
 */
const prisma = new PrismaClient();

const CARRIER = "018fa000-0000-7000-8000-00000000000a";
const OTHER = "018fa000-0000-7000-8000-00000000000b";

const id = (suffix: string) =>
  `018fa000-0000-7000-8000-${suffix.padStart(12, "0")}`;

const D1 = id("d1");
const D2 = id("d2");
const DX = id("dx");

const V1 = id("c1");

const ABSENT = id("f1");
const GATE = id("f2");
const OTHER_TYPE = id("f3");

const REPORTER = id("e1");

const R = (n: number) => id(`b${n}`);
const DELIVERY = (key: string) => id(`a${key.charCodeAt(0).toString(16)}`);

const at = (iso: string) => new Date(iso);
const date = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** 2026-09-17 in Rio Branco: [05:00Z, 05:00Z of the 18th). */
const DAY: OperationDay = operationDay(
  "America/Rio_Branco",
  at("2026-09-17T20:00:00.000Z"),
);

function scenario(): OperationRows {
  const route = (
    n: number,
    overrides: Partial<OperationRows["routes"][number]>,
  ): OperationRows["routes"][number] => ({
    id: R(n),
    businessId: CARRIER,
    code: 100 + n,
    name: `Rota ${n}`,
    destination: null,
    status: "PLANNED",
    scheduled_date: date("2026-09-17"),
    planned_departure_at: null,
    started_at: null,
    completed_at: null,
    updated_at: at("2026-09-15T12:00:00.000Z"),
    driverId: D1,
    vehicleId: null,
    ...overrides,
  });

  const delivery = (
    key: string,
    overrides: Partial<OperationRows["deliveries"][number]>,
  ): OperationRows["deliveries"][number] => ({
    id: DELIVERY(key),
    businessId: CARRIER,
    status: "PENDING",
    driverId: null,
    recipient_name: `Cliente ${key}`,
    city: "Rio Branco",
    delivered_at: null,
    updated_at: at("2026-09-10T12:00:00.000Z"),
    ...overrides,
  });

  const stop = (
    key: string,
    routeNumber: number,
    deliveryKey: string,
    sequence: number,
    status: string,
    completedAt: string | null = null,
  ): OperationRows["stops"][number] => ({
    id: id(`5${key}`),
    routeId: R(routeNumber),
    deliveryId: DELIVERY(deliveryKey),
    sequence,
    status,
    on_the_way_at: null,
    arrived_at: null,
    completed_at: completedAt ? at(completedAt) : null,
    updated_at: completedAt ? at(completedAt) : at("2026-09-15T12:00:00.000Z"),
  });

  const event = (
    key: string,
    deliveryKey: string,
    overrides: Partial<OperationRows["events"][number]>,
  ): OperationRows["events"][number] => ({
    id: id(`e${key}`),
    businessId: CARRIER,
    deliveryId: DELIVERY(deliveryKey),
    routeId: null,
    occurrenceId: null,
    type: "STATUS_CHANGE",
    actor: "USER",
    status_to: null,
    occurred_at: null,
    created_at: at("2026-09-17T12:00:00.000Z"),
    ...overrides,
  });

  return {
    businesses: [
      { id: CARRIER, timezone: "America/Rio_Branco" },
      { id: OTHER, timezone: "America/Sao_Paulo" },
    ],
    drivers: [
      { id: D1, businessId: CARRIER, name: "Ana", cnh: `cnh-${D1.slice(-6)}` },
      {
        id: D2,
        businessId: CARRIER,
        name: "Bruno",
        cnh: `cnh-${D2.slice(-6)}`,
      },
      { id: DX, businessId: OTHER, name: "Xavier", cnh: `cnh-${DX.slice(-6)}` },
    ],
    vehicles: [{ id: V1, license_plate: "ACR1B23" }],
    occurrenceTypes: [
      { id: ABSENT, name: "Cliente ausente", blocks_delivery: true },
      { id: GATE, name: "Portão fechado", blocks_delivery: false },
      { id: OTHER_TYPE, name: "Outra empresa", blocks_delivery: true },
    ],
    routes: [
      route(1, {
        status: "IN_PROGRESS",
        vehicleId: V1,
        planned_departure_at: at("2026-09-17T12:00:00.000Z"),
        started_at: at("2026-09-17T12:05:00.000Z"),
      }),
      // Yesterday's route, still on the street.
      route(2, {
        status: "IN_PROGRESS",
        driverId: D2,
        scheduled_date: date("2026-09-16"),
        started_at: at("2026-09-16T20:00:00.000Z"),
      }),
      route(3, {
        status: "COMPLETED",
        started_at: at("2026-09-17T08:00:00.000Z"),
        completed_at: at("2026-09-17T10:00:00.000Z"),
        updated_at: at("2026-09-17T10:00:00.000Z"),
      }),
      route(4, {
        status: "CANCELLED",
        driverId: D2,
        started_at: at("2026-09-17T09:00:00.000Z"),
        updated_at: at("2026-09-17T09:30:00.000Z"),
      }),
      route(5, { scheduled_date: date("2026-09-18") }),
      route(6, { status: "RELEASED", driverId: D2 }),
      // Tomorrow's, where a document that failed today was put back.
      route(8, { scheduled_date: date("2026-09-18"), driverId: D2 }),
      {
        ...route(7, { status: "IN_PROGRESS", driverId: DX }),
        businessId: OTHER,
      },
    ],
    deliveries: [
      delivery("a", {
        status: "DELIVERED",
        driverId: D1,
        delivered_at: at("2026-09-17T13:00:00.000Z"),
      }),
      delivery("b", {
        status: "FAILED",
        driverId: D1,
        updated_at: at("2026-09-17T13:31:00.000Z"),
      }),
      delivery("c", { status: "IN_TRANSIT", driverId: D1 }),
      delivery("e", { status: "IN_TRANSIT", driverId: D2 }),
      delivery("f", { status: "PENDING", driverId: D1 }),
      // 23:59 of the 16th in Rio Branco.
      delivery("g", {
        status: "DELIVERED",
        delivered_at: at("2026-09-17T04:59:00.000Z"),
      }),
      // 00:01 of the 17th in Rio Branco.
      delivery("h", {
        status: "DELIVERED",
        delivered_at: at("2026-09-17T05:01:00.000Z"),
      }),
      // Failed on the 16th, edited on the 17th.
      delivery("i", {
        status: "FAILED",
        updated_at: at("2026-09-17T15:00:00.000Z"),
      }),
      delivery("j", {
        status: "CANCELLED",
        updated_at: at("2026-09-17T16:00:00.000Z"),
      }),
      delivery("k", {
        status: "CANCELLED",
        updated_at: at("2026-09-16T16:00:00.000Z"),
      }),
      delivery("l", { status: "PENDING" }),
      delivery("m", { status: "PENDING", driverId: D2 }),
      delivery("n", { status: "PENDING", driverId: D2 }),
      // Delivered yesterday on the route that is still running today: yesterday's
      // work, not today's Entregues.
      delivery("o", {
        status: "DELIVERED",
        driverId: D2,
        delivered_at: at("2026-09-16T21:00:00.000Z"),
      }),
      // Failed today on Ana's route 1, then back in the queue (FAILED →
      // PENDING) on Bruno's route 8 tomorrow: today's Insucesso, Ana's.
      delivery("p", { status: "PENDING", driverId: D2 }),
      // Failed yesterday on route 2 (still running), back in the queue with
      // no route yet: neither today's Pendentes nor today's Insucesso.
      delivery("q", { status: "PENDING", driverId: D2 }),
      // Failed today on route 1 and put back on today's route 6: one
      // document, today's open work again.
      delivery("s", { status: "PENDING", driverId: D2 }),
      {
        ...delivery("x", {
          status: "DELIVERED",
          delivered_at: at("2026-09-17T13:00:00.000Z"),
        }),
        businessId: OTHER,
      },
      {
        ...delivery("y", { status: "IN_TRANSIT" }),
        businessId: OTHER,
      },
    ],
    stops: [
      stop("1", 1, "a", 1, "COMPLETED", "2026-09-17T13:00:00.000Z"),
      stop("2", 1, "b", 2, "FAILED", "2026-09-17T13:30:00.000Z"),
      stop("3", 1, "c", 3, "PENDING"),
      stop("4", 2, "e", 1, "PENDING"),
      stop("5", 5, "f", 1, "PENDING"),
      stop("6", 4, "m", 1, "CANCELLED", "2026-09-17T09:30:00.000Z"),
      stop("7", 6, "n", 1, "PENDING"),
      stop("8", 7, "y", 1, "PENDING"),
      stop("9", 2, "o", 2, "COMPLETED", "2026-09-16T21:00:00.000Z"),
      stop("a", 1, "p", 4, "FAILED", "2026-09-17T14:30:00.000Z"),
      stop("b", 8, "p", 1, "PENDING"),
      stop("c", 2, "q", 3, "FAILED", "2026-09-16T20:30:00.000Z"),
      stop("d", 1, "s", 5, "FAILED", "2026-09-17T14:40:00.000Z"),
      stop("e", 6, "s", 2, "PENDING"),
    ],
    events: [
      event("1", "a", {
        type: "ARRIVAL",
        actor: "DRIVER_APP",
        routeId: R(1),
        created_at: at("2026-09-17T12:50:00.000Z"),
      }),
      event("2", "a", {
        type: "PROOF",
        actor: "DRIVER_APP",
        routeId: R(1),
        occurred_at: at("2026-09-17T12:58:00.000Z"),
        created_at: at("2026-09-17T13:00:00.000Z"),
      }),
      event("3", "i", {
        status_to: "FAILED",
        occurred_at: at("2026-09-16T20:00:00.000Z"),
        created_at: at("2026-09-16T20:00:00.000Z"),
      }),
      event("4", "j", {
        status_to: "CANCELLED",
        created_at: at("2026-09-17T16:00:00.000Z"),
      }),
      event("5", "k", {
        status_to: "CANCELLED",
        created_at: at("2026-09-16T16:00:00.000Z"),
      }),
      {
        ...event("6", "x", {
          type: "PROOF",
          actor: "DRIVER_APP",
          created_at: at("2026-09-17T13:00:00.000Z"),
        }),
        businessId: OTHER,
      },
      // The OCCURRENCE event of a blocking report still waiting for a
      // manager (decision 6.3): nothing has failed yet.
      event("7", "c", {
        type: "OCCURRENCE",
        actor: "DRIVER_APP",
        routeId: R(1),
        occurrenceId: id("0c2"),
        created_at: at("2026-09-17T15:00:00.000Z"),
      }),
    ],
    occurrences: [
      {
        id: id("0b1"),
        businessId: CARRIER,
        deliveryId: DELIVERY("b"),
        occurrenceTypeId: ABSENT,
        authorization_status: "NOT_REQUIRED",
        occurred_at: at("2026-09-17T13:29:00.000Z"),
        created_at: at("2026-09-17T13:30:00.000Z"),
      },
      {
        id: id("0c1"),
        businessId: CARRIER,
        deliveryId: DELIVERY("c"),
        occurrenceTypeId: GATE,
        authorization_status: "NOT_REQUIRED",
        occurred_at: null,
        created_at: at("2026-09-17T14:00:00.000Z"),
      },
      {
        id: id("0c2"),
        businessId: CARRIER,
        deliveryId: DELIVERY("c"),
        occurrenceTypeId: ABSENT,
        authorization_status: "PENDING",
        occurred_at: null,
        created_at: at("2026-09-17T15:00:00.000Z"),
      },
      {
        id: id("0y1"),
        businessId: OTHER,
        deliveryId: DELIVERY("y"),
        occurrenceTypeId: OTHER_TYPE,
        authorization_status: "NOT_REQUIRED",
        occurred_at: null,
        created_at: at("2026-09-17T14:00:00.000Z"),
      },
    ],
  };
}

async function seedPostgres(rows: OperationRows): Promise<void> {
  for (const business of rows.businesses) {
    await prisma.business.create({
      data: {
        id: business.id,
        timezone: business.timezone,
        corporate_reason: `Transportadora ${business.id.slice(-4)}`,
        cep: "69900000",
        city: "Rio Branco",
        uf: "AC",
        street: "Rua",
        address_number: "1",
        cnpj: `${business.id.slice(-4)}${Date.now()}`.slice(0, 14),
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "68999999999",
        email: `${randomUUID()}@exemplo.com.br`,
      },
    });
  }

  for (const driver of rows.drivers) {
    await prisma.driver.create({
      data: {
        id: driver.id,
        name: driver.name,
        birth_date: new Date("1990-01-01"),
        cnh: driver.cnh ?? `cnh-${driver.id.slice(-6)}`,
        cpf: `cpf-${driver.id.slice(-6)}`,
        rg: `rg-${driver.id.slice(-6)}`,
        cep: "69900000",
        city: "Rio Branco",
        uf: "AC",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: driver.businessId,
      },
    });
  }

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  for (const vehicle of rows.vehicles) {
    await prisma.vehicle.create({
      data: {
        id: vehicle.id,
        description: "Caminhão",
        license_plate: vehicle.license_plate,
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 0,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: `renavam-${vehicle.id.slice(-6)}`,
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId: CARRIER,
        fuelTypeId: fuelType.id,
      },
    });
  }

  for (const type of rows.occurrenceTypes) {
    await prisma.occurrenceType.create({
      data: {
        id: type.id,
        name: type.name,
        blocks_delivery: type.blocks_delivery,
        businessId: type.id === OTHER_TYPE ? OTHER : CARRIER,
      },
    });
  }

  await prisma.user.create({
    data: {
      id: REPORTER,
      name: "Relator",
      email: `relator-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const shippers = new Map<string, string>();

  for (const business of rows.businesses) {
    const shipper = await prisma.shipper.create({
      data: {
        name: `Embarcador ${business.id.slice(-4)}`,
        businessId: business.id,
      },
    });

    shippers.set(business.id, shipper.id);
  }

  for (const route of rows.routes) {
    await prisma.route.create({ data: { ...route } });
  }

  for (const delivery of rows.deliveries) {
    await prisma.delivery.create({
      data: {
        ...delivery,
        uf: "AC",
        street: "Rua",
        shipperId: shippers.get(delivery.businessId) as string,
      },
    });
  }

  for (const stop of rows.stops) {
    await prisma.routeStop.create({
      data: { ...stop, status: stop.status as never },
    });
  }

  for (const occurrence of rows.occurrences) {
    await prisma.deliveryOccurrence.create({
      data: {
        ...occurrence,
        authorization_status: occurrence.authorization_status as never,
        reportedById: REPORTER,
      },
    });
  }

  for (const event of rows.events) {
    await prisma.deliveryEvent.create({
      data: {
        ...event,
        type: event.type as never,
        actor: event.actor as never,
      },
    });
  }

  // `@updatedAt` is stamped by Prisma on every write above; the scenario's
  // timestamps are the fact under test, so they are put back by hand.
  for (const route of rows.routes) {
    await prisma.$executeRaw`UPDATE "route" SET "updated_at" = ${route.updated_at} WHERE "id" = ${route.id}`;
  }

  for (const delivery of rows.deliveries) {
    await prisma.$executeRaw`UPDATE "delivery" SET "updated_at" = ${delivery.updated_at} WHERE "id" = ${delivery.id}`;
  }

  for (const stop of rows.stops) {
    await prisma.$executeRaw`UPDATE "route_stop" SET "updated_at" = ${stop.updated_at} WHERE "id" = ${stop.id}`;
  }
}

const database: IOperationDayRepository = new OperationDayRepository();
const twin = new InMemoryOperationDayRepository();

beforeAll(async () => {
  const rows = scenario();

  twin.rows = rows;

  await seedPostgres(scenario());
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

type Implementation = [string, IOperationDayRepository];

const both = (): Implementation[] => [
  ["Postgres", database],
  ["in-memory", twin],
];

const sortCounts = (
  rows: Array<{ driverId: string | null; status: string; total: number }>,
) =>
  [...rows].sort((a, b) =>
    `${a.status}|${a.driverId ?? ""}`.localeCompare(
      `${b.status}|${b.driverId ?? ""}`,
    ),
  );

const feedKey = (entries: FeedEntry[]) =>
  [...entries]
    .sort(
      (a, b) =>
        b.receivedAt.getTime() - a.receivedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((entry) => ({
      ...entry,
      occurredAt: entry.occurredAt.toISOString(),
      receivedAt: entry.receivedAt.toISOString(),
    }));

describe("the company's zone", () => {
  it.each(both())(
    "%s reads the zone of the company",
    async (_name, repository) => {
      expect(await repository.timeZoneOf(CARRIER)).toBe("America/Rio_Branco");
      expect(await repository.timeZoneOf(id("404"))).toBeNull();
    },
  );

  it("places the day at 05:00 UTC in Rio Branco", () => {
    expect(DAY.start.toISOString()).toBe("2026-09-17T05:00:00.000Z");
    expect(DAY.end.toISOString()).toBe("2026-09-18T05:00:00.000Z");
  });
});

describe("the active documents of the day", () => {
  const expected = [
    { driverId: null, status: "CANCELLED", total: 1 }, // j, by the event
    { driverId: null, status: "DELIVERED", total: 1 }, // h at 00:01; not g at 23:59
    { driverId: D1, status: "DELIVERED", total: 1 }, // a
    { driverId: D1, status: "FAILED", total: 2 }, // b today; p failed today on route 1 and requeued; not i, edited today
    { driverId: D1, status: "IN_TRANSIT", total: 1 }, // c
    { driverId: D2, status: "IN_TRANSIT", total: 1 }, // e, yesterday's running route; not o, delivered yesterday on it
    { driverId: D2, status: "PENDING", total: 2 }, // n and s on today's released route; not q, failed yesterday
  ];

  it.each(both())(
    "%s counts exactly the day's documents",
    async (_name, repository) => {
      expect(
        sortCounts(
          await repository.countDayDeliveries(CARRIER, {
            ...DAY,
            isToday: true,
          }),
        ),
      ).toEqual(sortCounts(expected));
    },
  );

  it.each(both())(
    "%s leaves out what is running now when the day is not today",
    async (_name, repository) => {
      const counts = await repository.countDayDeliveries(CARRIER, {
        ...DAY,
        isToday: false,
      });

      // e is on yesterday's route and only belongs to "today" while it runs.
      expect(
        counts.find(
          (row) => row.driverId === D2 && row.status === "IN_TRANSIT",
        ),
      ).toBeUndefined();
    },
  );

  it.each(both())(
    "%s leaves out what a still-running route resolved on an earlier day",
    async (_name, repository) => {
      const counts = await repository.countDayDeliveries(CARRIER, {
        ...DAY,
        isToday: true,
      });

      // o was delivered on the 16th on route 2, which is still running: its
      // open stop (e) is today's work, its delivered one is not.
      expect(
        counts.find((row) => row.driverId === D2 && row.status === "DELIVERED"),
      ).toBeUndefined();
      expect(
        counts.find((row) => row.driverId === D2 && row.status === "IN_TRANSIT")
          ?.total,
      ).toBe(1);
    },
  );

  it.each(both())(
    "%s counts a document that failed today and went back to the queue as that route's Insucesso",
    async (_name, repository) => {
      const counts = await repository.countDayDeliveries(CARRIER, {
        ...DAY,
        isToday: true,
      });

      // p is PENDING now, with Bruno, on tomorrow's route 8. Under its
      // current status it sat in today's Pendentes as Bruno's, and Ana's
      // failure of today was nowhere.
      expect(
        counts.find((row) => row.driverId === D1 && row.status === "FAILED")
          ?.total,
      ).toBe(2);
      expect(
        counts.find((row) => row.driverId === D2 && row.status === "PENDING")
          ?.total,
      ).toBe(2);
    },
  );

  it.each(both())(
    "%s leaves out what a still-running route failed on an earlier day and was requeued",
    async (_name, repository) => {
      const counts = await repository.countDayDeliveries(CARRIER, {
        ...DAY,
        isToday: true,
      });

      // q failed on the 16th on route 2 and went back to the queue: the
      // route still running does not make it today's work.
      const total = counts.reduce((sum, row) => sum + row.total, 0);

      expect(total).toBe(9);
    },
  );

  it.each(both())(
    "%s never counts another company's documents",
    async (_name, repository) => {
      const counts = await repository.countDayDeliveries(OTHER, {
        ...DAY,
        isToday: true,
      });

      expect(sortCounts(counts)).toEqual(
        sortCounts([
          { driverId: null, status: "DELIVERED", total: 1 },
          { driverId: null, status: "IN_TRANSIT", total: 1 },
        ]),
      );
    },
  );
});

describe("the drivers the board by driver names", () => {
  it.each(both())(
    "%s names only the company's drivers",
    async (_name, repository) => {
      const drivers = await repository.listDrivers(CARRIER, [
        D1,
        D2,
        DX,
        id("404"),
      ]);

      expect([...drivers].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: D1, name: "Ana", cnh: `cnh-${D1.slice(-6)}` },
        { id: D2, name: "Bruno", cnh: `cnh-${D2.slice(-6)}` },
      ]);

      expect(await repository.listDrivers(CARRIER, [])).toEqual([]);
    },
  );
});

describe("the routes the tower reasons about", () => {
  const endedSince = at("2026-09-17T09:00:00.000Z");

  it.each(both())(
    "%s lists today's, running and recently ended routes",
    async (_name, repository) => {
      const routes = await repository.listTowerRoutes(
        CARRIER,
        { ...DAY, isToday: true },
        endedSince,
      );

      expect(routes.map((route) => route.code)).toEqual([
        101, 102, 103, 104, 106,
      ]);

      const running = routes.find((route) => route.code === 101);

      expect(running).toMatchObject({
        driverName: "Ana",
        vehiclePlate: "ACR1B23",
      });
      expect(running?.stops.map((stop) => stop.status).sort()).toEqual([
        "COMPLETED",
        "FAILED",
        "FAILED",
        "FAILED",
        "PENDING",
      ]);

      expect(
        routes.find((route) => route.code === 104)?.ended_at?.toISOString(),
      ).toBe("2026-09-17T09:30:00.000Z");
    },
  );

  it("gives the same answer from both", async () => {
    const [fromDatabase, fromTwin] = await Promise.all([
      database.listTowerRoutes(CARRIER, { ...DAY, isToday: true }, endedSince),
      twin.listTowerRoutes(CARRIER, { ...DAY, isToday: true }, endedSince),
    ]);

    const normalise = (routes: typeof fromDatabase) =>
      routes.map((route) => ({
        ...route,
        stops: [...route.stops].sort((a, b) =>
          a.status.localeCompare(b.status),
        ),
      }));

    expect(normalise(fromDatabase)).toEqual(normalise(fromTwin));
  });
});

describe("the feed of the day", () => {
  it.each(both())(
    "%s lists occurrences and route moves next to the delivery events",
    async (_name, repository) => {
      const feed = feedKey(
        await repository.listFeed(CARRIER, { ...DAY, isToday: true }, 15),
      );

      expect(feed.map((entry) => entry.type)).toEqual([
        "STATUS_CHANGE", // j cancelled, 16:00
        "OCCURRENCE", // c, absent, awaiting authorisation, 15:00 (the event; its row is skipped)
        "OCCURRENCE", // c, gate, 14:00
        "OCCURRENCE", // b, absent, 13:30
        "PROOF", // a, 13:00
        "ARRIVAL", // a, 12:50
        "ROUTE_STARTED", // r1, 12:05
        "ROUTE_COMPLETED", // r3, 10:00
        "ROUTE_CANCELLED", // r4, 09:30
        "ROUTE_STARTED", // r4, 09:00
        "ROUTE_STARTED", // r3, 08:00
      ]);

      const blocking = feed.find(
        (entry) => entry.id === `occurrence:${id("0b1")}`,
      );

      expect(blocking).toMatchObject({
        detail: "Cliente ausente",
        failure: true,
        driverName: "Ana",
        occurredAt: "2026-09-17T13:29:00.000Z",
      });

      // Blocking, but waiting for a manager: the same line from the event
      // as from the row, and not red (decision 6.3).
      expect(
        feed.find((entry) => entry.id === `delivery_event:${id("e7")}`),
      ).toMatchObject({
        source: "delivery_event",
        detail: "Cliente ausente",
        failure: false,
      });
      expect(feed.some((entry) => entry.id === `occurrence:${id("0c2")}`)).toBe(
        false,
      );

      // The proof keeps the hour it happened, and yesterday's failure of i
      // is not in today's feed.
      expect(feed.find((entry) => entry.type === "PROOF")?.occurredAt).toBe(
        "2026-09-17T12:58:00.000Z",
      );
    },
  );

  it("gives the same answer from both", async () => {
    const [fromDatabase, fromTwin] = await Promise.all([
      database.listFeed(CARRIER, { ...DAY, isToday: true }, 15),
      twin.listFeed(CARRIER, { ...DAY, isToday: true }, 15),
    ]);

    expect(feedKey(fromDatabase)).toEqual(feedKey(fromTwin));
  });

  it.each(both())(
    "%s reads only the newest route moves, not every route of the day",
    async (_name, repository) => {
      // The widget shows fifteen lines; a big tenant starts hundreds of
      // routes a day, and each poll used to read all of them.
      const feed = feedKey(
        await repository.listFeed(CARRIER, { ...DAY, isToday: true }, 1),
      );

      const routeLines = feed
        .filter((entry) => entry.source === "route")
        .map((entry) => entry.id);

      expect(routeLines).toEqual([
        `route:${R(1)}:started`, // 12:05, the newest start; not r4 (09:00) nor r3 (08:00)
        `route:${R(3)}:completed`,
        `route:${R(4)}:cancelled`,
      ]);
    },
  );
});

describe("the monitoring board by route", () => {
  it.each(both())(
    "%s orders running, released, then finished",
    async (_name, repository) => {
      const { total, routes } = await repository.listMonitoringRoutes(
        CARRIER,
        { ...DAY, isToday: true },
        { skip: 0, take: 20 },
      );

      expect(total).toBe(4);
      expect(routes.map((route) => route.code)).toEqual([101, 102, 106, 103]);
      expect(routes[0].stops.map((stop) => stop.sequence)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(routes[0].stops[1]).toMatchObject({
        status: "FAILED",
        recipientName: "Cliente b",
      });
    },
  );

  it.each(both())(
    "%s keeps the total past the last page",
    async (_name, repository) => {
      const { total, routes } = await repository.listMonitoringRoutes(
        CARRIER,
        { ...DAY, isToday: true },
        { skip: 40, take: 20 },
      );

      expect(routes).toEqual([]);
      expect(total).toBe(4);
    },
  );

  it("gives the same answer from both", async () => {
    const page = { skip: 1, take: 2 };

    const [fromDatabase, fromTwin] = await Promise.all([
      database.listMonitoringRoutes(CARRIER, { ...DAY, isToday: true }, page),
      twin.listMonitoringRoutes(CARRIER, { ...DAY, isToday: true }, page),
    ]);

    expect(fromDatabase).toEqual(fromTwin);
  });
});
