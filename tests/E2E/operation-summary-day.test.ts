import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import type { OperationDay } from "@/modules/route/repositories/IOperation-day-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

import { readOperationSummary } from "@/modules/delivery/usecases/operation-summary/read-operation-summary";
import { DriverMonitoringUseCase } from "@/modules/route/usecases/driver-monitoring/driver-monitoring-usecase";
import { ControlTowerUseCase } from "@/modules/route/usecases/control-tower/control-tower-usecase";
import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";

import { operationDay } from "@/shared/route/operation-day-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What the operation summary counts as the company's day, on the real tables.
 *
 * The day is fixed (27/09/2026 in Manaus, UTC-4) and handed to the reads, so
 * nothing here depends on when or where the suite runs.
 *
 * Designated, in route, delivered and failed are the tower's active documents
 * of the day (decision 7.1, DLV-MON-3), read from
 * OperationDayRepository.countDayDeliveries — the funnel's and the board by
 * driver's definition, not a second one:
 * - designated: PENDING with a driver on a route of the day, or on a route
 *   still running when the day is today. Tomorrow's route, yesterday's that
 *   never left and a delivery with a driver and NO route are not the day's
 *   load (the summary once counted the last one and disagreed with the tower);
 * - DELIVERED by `delivered_at` inside [start, end);
 * - FAILED by the latest failure fact — a STATUS_CHANGE to FAILED, a blocking
 *   occurrence that applied, a stop settled as FAILED — and `updated_at` only
 *   when there is no fact (DLVP-OPS-3), plus whatever failed on a route of
 *   the day.
 *
 * The two numbers of the summary's own: "Sem rota", PENDING without a driver
 * of any date; occurrences reported by a driver's account, placed by when
 * they happened on the phone, without the platform's own types (DLVP-OPS-2).
 */
const prisma = createPrismaClient();
const operation = new OperationDayRepository();
const deliveries = new DeliveryRepository();

const read = (businessId: string, day: OperationDay) =>
  readOperationSummary({ operation, delivery: deliveries }, businessId, day);

const MANAUS = "America/Manaus";

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const OTHER = "018fe100-0000-7000-8000-00000000000b";

const MANAGER = "018fe100-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fe100-0000-7000-8000-0000000000a2";
const OTHER_DRIVER_USER = "018fe100-0000-7000-8000-0000000000a3";

const DRIVER = "018fe100-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018fe100-0000-7000-8000-0000000000d2";

const SHIPPER = "018fe100-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fe100-0000-7000-8000-0000000000f2";

const BLOCKING = "018fe100-0000-7000-8000-0000000000e1";
const INFO = "018fe100-0000-7000-8000-0000000000e2";
const SYSTEM = "018fe100-0000-7000-8000-0000000000e3";
const OTHER_INFO = "018fe100-0000-7000-8000-0000000000e4";

// [27T04:00Z, 28T04:00Z): the 27th in Manaus, the company's current day.
const CLOCK = new Date("2026-09-27T15:00:00.000Z");
const DAY = operationDay(MANAUS, CLOCK);
// The 26th, looked at from the 27th.
const PREVIOUS_DAY = operationDay(MANAUS, CLOCK, "2026-09-26");

const hours = (count: number) => count * 60 * 60 * 1000;
const TODAY = new Date(DAY.start.getTime() + hours(12)); // 12:00 in Manaus
const YESTERDAY = new Date(DAY.start.getTime() - hours(1)); // 23:00 of the 26th
const TOMORROW = new Date(DAY.end.getTime()); // 00:00 of the 28th: outside

async function seedBusiness(id: string, shipper: string, timezone?: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      cnpj: String(54000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "92999999999",
      email: `dia-${randomUUID()}@exemplo.com.br`,
      ...(timezone && { timezone }),
    },
  });

  await prisma.shipper.create({
    data: { id: shipper, name: "Embarcador", businessId: id },
  });
}

async function seedDriver(id: string, businessId: string) {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Math.floor(Math.random() * 1e11)).padStart(11, "0"),
      rg: randomUUID().slice(0, 9),
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

/** A delivery, with `updated_at` forced (it is @updatedAt). */
async function delivery(
  code: string,
  data: {
    status: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "FAILED";
    driverId?: string | null;
    delivered_at?: Date;
    updated_at?: Date;
    businessId?: string;
  },
): Promise<string> {
  const businessId = data.businessId ?? CARRIER;

  const row = await prisma.delivery.create({
    data: {
      businessId,
      shipperId: businessId === CARRIER ? SHIPPER : OTHER_SHIPPER,
      code,
      recipient_name: `Cliente ${code}`,
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      status: data.status,
      driverId: data.driverId === undefined ? DRIVER : data.driverId,
      delivered_at: data.delivered_at,
    },
  });

  await prisma.$executeRaw`
    UPDATE "delivery" SET "updated_at" = (${data.updated_at ?? TODAY}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${row.id}
  `;

  return row.id;
}

async function occurrence(
  deliveryId: string,
  data: {
    type: string;
    reportedById: string;
    occurred_at?: Date | null;
    created_at?: Date;
    authorization_status?: "NOT_REQUIRED" | "PENDING" | "APPROVED" | "DENIED";
    businessId?: string;
  },
) {
  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId,
      businessId: data.businessId ?? CARRIER,
      occurrenceTypeId: data.type,
      reportedById: data.reportedById,
      occurred_at: data.occurred_at ?? null,
      created_at: data.created_at ?? TODAY,
      authorization_status: data.authorization_status ?? "NOT_REQUIRED",
    },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER, SHIPPER, MANAUS);
  await seedBusiness(OTHER, OTHER_SHIPPER);

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(OTHER_DRIVER, OTHER);

  await prisma.user.createMany({
    data: [
      {
        id: MANAGER,
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        driverId: null,
      },
      {
        id: DRIVER_USER,
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
      },
      {
        id: OTHER_DRIVER_USER,
        role: "BUSINESS_USER",
        businessId: OTHER,
        driverId: OTHER_DRIVER,
      },
    ].map((user) => ({
      ...user,
      name: `Usuário ${user.id.slice(-2)}`,
      email: `dia-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
    })) as never,
  });

  await prisma.occurrenceType.createMany({
    data: [
      {
        id: BLOCKING,
        name: "Recusada",
        blocks_delivery: true,
        businessId: CARRIER,
      },
      { id: INFO, name: "Atraso", businessId: CARRIER },
      {
        id: SYSTEM,
        name: "Comprovante rejeitado",
        is_system: true,
        businessId: CARRIER,
      },
      { id: OTHER_INFO, name: "Atraso", businessId: OTHER },
    ],
  });

  // ---- DELIVERED ----
  await delivery("D-today", { status: "DELIVERED", delivered_at: TODAY });
  await delivery("D-yesterday", {
    status: "DELIVERED",
    delivered_at: YESTERDAY,
  });
  await delivery("D-tomorrow", { status: "DELIVERED", delivered_at: TOMORROW });

  // ---- FAILED ----
  // Failed yesterday by the panel, edited today: not today's.
  const edited = await delivery("F-edited", { status: "FAILED" });
  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      deliveryId: edited,
      businessId: CARRIER,
      status_from: "IN_TRANSIT",
      status_to: "FAILED",
      reportedById: MANAGER,
      created_at: YESTERDAY,
    },
  });

  // Failed today by a blocking report from the app.
  const blocked = await delivery("F-blocked", { status: "FAILED" });
  await occurrence(blocked, {
    type: BLOCKING,
    reportedById: DRIVER_USER,
    occurred_at: TODAY,
  });

  // Failed yesterday; a blocking report still waiting for the tower today
  // has not applied, so it is not a failure fact.
  const waiting = await delivery("F-waiting", { status: "FAILED" });
  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      deliveryId: waiting,
      businessId: CARRIER,
      status_from: "IN_TRANSIT",
      status_to: "FAILED",
      reportedById: MANAGER,
      created_at: YESTERDAY,
    },
  });
  await occurrence(waiting, {
    type: BLOCKING,
    reportedById: DRIVER_USER,
    authorization_status: "PENDING",
  });

  // Failed today on a route: the stop settled as FAILED is the fact.
  const onRoute = await delivery("F-stop", { status: "FAILED" });
  const route = await prisma.route.create({
    data: {
      code: 1,
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date("2026-09-27"),
      status: "IN_PROGRESS",
    },
  });
  await prisma.routeStop.create({
    data: {
      routeId: route.id,
      deliveryId: onRoute,
      sequence: 10,
      status: "FAILED",
      completed_at: TODAY,
    },
  });

  // Failed yesterday on a route whose stop has no completed_at (route
  // outcomes may omit it), edited today. LEAST(completed_at, updated_at)
  // skips the NULL, so the fact is the stop's updated_at (yesterday); the
  // delivery's own updated_at (today) is not used when a fact exists. It is
  // still on route 1, a route of the 27th: the tower counts it that day too.
  const stopWithoutTime = await delivery("F-stop-open", { status: "FAILED" });
  const openStop = await prisma.routeStop.create({
    data: {
      routeId: route.id,
      deliveryId: stopWithoutTime,
      sequence: 20,
      status: "FAILED",
      completed_at: null,
    },
  });
  await prisma.$executeRaw`
    UPDATE "route_stop" SET "updated_at" = (${YESTERDAY}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${openStop.id}
  `;

  // A legacy failure with no fact, moved today / yesterday.
  await delivery("F-legacy-today", { status: "FAILED", driverId: null });
  await delivery("F-legacy-yesterday", {
    status: "FAILED",
    updated_at: YESTERDAY,
  });

  // ---- PENDING ---- the day's load is decided by the route of the open stop.
  const pendingOn = async (
    code: string,
    routeCode: number,
    scheduled: string,
    status: "PLANNED" | "RELEASED" | "IN_PROGRESS",
  ) => {
    const id = await delivery(code, { status: "PENDING" });
    const planned = await prisma.route.create({
      data: {
        code: routeCode,
        businessId: CARRIER,
        driverId: DRIVER,
        scheduled_date: new Date(scheduled),
        status,
      },
    });
    await prisma.routeStop.create({
      data: {
        routeId: planned.id,
        deliveryId: id,
        sequence: 10,
        status: "PENDING",
      },
    });
  };

  await pendingOn("P-today", 2, "2026-09-27", "RELEASED"); // designated
  await pendingOn("P-running", 3, "2026-09-26", "IN_PROGRESS"); // designated: still out
  await pendingOn("P-tomorrow", 4, "2026-09-28", "PLANNED"); // tomorrow's load
  await pendingOn("P-stale", 5, "2026-09-26", "RELEASED"); // yesterday's, never left
  await delivery("P-legacy", { status: "PENDING" }); // a driver, no route: not the day's
  await delivery("P-backlog", { status: "PENDING", driverId: null }); // Sem rota

  // ---- OCCURRENCES ---- (on an open delivery, so they are not failures)
  const open = await delivery("T-open", { status: "IN_TRANSIT" });

  await occurrence(open, { type: INFO, reportedById: DRIVER_USER }); // counts
  await occurrence(open, {
    type: INFO,
    reportedById: DRIVER_USER,
    occurred_at: TODAY,
  }); // counts
  await occurrence(open, { type: INFO, reportedById: MANAGER }); // panel note
  await occurrence(open, { type: SYSTEM, reportedById: DRIVER_USER }); // platform's
  await occurrence(open, {
    type: INFO,
    reportedById: DRIVER_USER,
    occurred_at: YESTERDAY, // offline, arrived today
  });
  await occurrence(open, {
    type: INFO,
    reportedById: DRIVER_USER,
    created_at: YESTERDAY,
  });

  // ---- ANOTHER COMPANY, all of it "today" ----
  const foreign = await delivery("X-1", {
    status: "DELIVERED",
    delivered_at: TODAY,
    businessId: OTHER,
    driverId: OTHER_DRIVER,
  });
  await delivery("X-2", {
    status: "FAILED",
    businessId: OTHER,
    driverId: OTHER_DRIVER,
  });
  await occurrence(foreign, {
    type: OTHER_INFO,
    reportedById: OTHER_DRIVER_USER,
    businessId: OTHER,
  });
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The delivery twin loaded with the very rows above (decision 13.2): the
 * unit tests trust it for the backlog and the reports, so it has to give the
 * database's answer.
 */
async function deliveryTwinFromDatabase(): Promise<InMemoryDeliveryRepository> {
  const twin = new InMemoryDeliveryRepository();
  const tenants = { in: [CARRIER, OTHER] };

  twin.deliveries.push(
    ...((await prisma.delivery.findMany({
      where: { businessId: tenants },
    })) as never[]),
  );
  twin.occurrences.push(
    ...((await prisma.deliveryOccurrence.findMany({
      where: { businessId: tenants },
    })) as never[]),
  );

  for (const type of await prisma.occurrenceType.findMany({
    where: { businessId: tenants },
  })) {
    twin.occurrenceTypeSystem.set(type.id, type.is_system);
  }

  for (const user of await prisma.user.findMany({
    where: { businessId: tenants, driverId: { not: null } },
  })) {
    twin.driverUserIds.add(user.id);
  }

  return twin;
}

/** The tower's twin, loaded with the same rows, for the unit tests' pair. */
async function operationTwinFromDatabase(): Promise<InMemoryOperationDayRepository> {
  const twin = new InMemoryOperationDayRepository();
  const tenants = { in: [CARRIER, OTHER] };

  twin.rows = {
    businesses: (
      await prisma.business.findMany({
        where: { id: tenants },
        select: { id: true, timezone: true },
      })
    ).map((business) => ({
      id: business.id,
      timezone: business.timezone ?? undefined,
    })),
    drivers: await prisma.driver.findMany({
      where: { businessId: tenants },
      select: { id: true, businessId: true, name: true, cnh: true },
    }),
    vehicles: [],
    occurrenceTypes: await prisma.occurrenceType.findMany({
      where: { businessId: tenants },
      select: { id: true, name: true, blocks_delivery: true },
    }),
    routes: (await prisma.route.findMany({
      where: { businessId: tenants },
    })) as never[],
    stops: (await prisma.routeStop.findMany({
      where: { route: { businessId: tenants } },
    })) as never[],
    deliveries: (await prisma.delivery.findMany({
      where: { businessId: tenants },
    })) as never[],
    events: (await prisma.deliveryEvent.findMany({
      where: { businessId: tenants },
    })) as never[],
    occurrences: (await prisma.deliveryOccurrence.findMany({
      where: { businessId: tenants },
    })) as never[],
  };

  return twin;
}

const CASES = [
  ["the carrier's day", CARRIER, DAY],
  ["the carrier's previous day", CARRIER, PREVIOUS_DAY],
  ["the other company's day", OTHER, DAY],
] as const;

describe("the operation summary of a company's day", () => {
  it("counts each number by its own definition", async () => {
    const summary = await read(CARRIER, DAY);

    expect(summary.totals).toEqual({
      unassigned: 1, // P-backlog
      // P-today and P-running. Not P-tomorrow, P-stale, nor P-legacy (a
      // driver and no route): none is on a route of the day.
      designated: 2,
      inRoute: 1, // T-open
      deliveredToday: 1, // D-today
      // F-blocked, F-stop and F-legacy-today by their facts, and F-stop-open:
      // it failed on route 1, a route of the day, so the day holds it.
      failedToday: 4,
      // Two on T-open, plus the driver's reports on F-blocked and F-waiting
      // (a report waiting for the tower is still a report).
      occurrencesToday: 4,
    });
  });

  it("files the day's documents under the driver who holds them", async () => {
    const summary = await read(CARRIER, DAY);

    expect(summary.drivers).toEqual([
      {
        driverId: DRIVER,
        driverName: "Motorista d1",
        cnh: expect.any(String),
        designated: 2,
        inRoute: 1,
        deliveredToday: 1,
        // F-legacy-today has no driver: in the total, not in a row.
        failedToday: 3,
      },
    ]);
  });

  it("moves with the day it is given, not with the clock", async () => {
    const summary = await read(CARRIER, PREVIOUS_DAY);

    expect(summary.totals.deliveredToday).toBe(1); // D-yesterday

    // F-edited and F-waiting failed on the 26th (their panel change);
    // F-stop-open by its stop; F-legacy-yesterday has no fact and moved on
    // the 26th.
    expect(summary.totals.failedToday).toBe(4);

    // The one created on the 26th and the offline one that happened then.
    expect(summary.totals.occurrencesToday).toBe(2);

    // The 26th's routes (P-running, P-stale). P-legacy is on no route.
    expect(summary.totals.designated).toBe(2);

    // A past day has nothing "out now": T-open is on no route of the 26th.
    expect(summary.totals.inRoute).toBe(0);
  });

  it("never reads another company's rows", async () => {
    const summary = await read(OTHER, DAY);

    expect(summary.totals).toEqual({
      unassigned: 0,
      designated: 0,
      inRoute: 0,
      deliveredToday: 1,
      failedToday: 1,
      occurrencesToday: 1,
    });

    expect(summary.drivers).toEqual([
      expect.objectContaining({
        driverId: OTHER_DRIVER,
        driverName: "Motorista d2",
      }),
    ]);
  });
});

/**
 * Decision 7.1: the funnel, the board by driver and the summary are ONE
 * definition. Asserted against the tower's own consumers, so a summary that
 * grows its own query again (and counts P-legacy, say) fails here even if its
 * numbers look plausible.
 */
describe("the same day as the tower", () => {
  const users = new UserRepository();

  it.each(CASES)(
    "totals are the tower's counts, %s",
    async (_, businessId, day) => {
      const counts = await operation.countDayDeliveries(businessId, day);
      const summary = await read(businessId, day);

      const sum = (status: string, withDriver = false) =>
        counts
          .filter(
            (entry) =>
              entry.status === status && (!withDriver || entry.driverId),
          )
          .reduce((total, entry) => total + entry.total, 0);

      expect(summary.totals).toMatchObject({
        designated: sum("PENDING", true),
        inRoute: sum("IN_TRANSIT"),
        deliveredToday: sum("DELIVERED"),
        failedToday: sum("FAILED"),
      });
    },
  );

  it("the funnel of the control tower says the same about today", async () => {
    const tower = await new ControlTowerUseCase(
      users,
      new DriverPositionRepository(),
      operation,
    ).execute({ userId: MANAGER, now: CLOCK });

    const summary = await read(CARRIER, DAY);
    const funnel = Object.fromEntries(
      tower.funnel.map((step) => [step.status, step.total]),
    );

    // Every PENDING of the day has a driver here (routes carry one).
    expect(funnel).toMatchObject({
      PENDING: summary.totals.designated,
      IN_TRANSIT: summary.totals.inRoute,
      DELIVERED: summary.totals.deliveredToday,
      FAILED: summary.totals.failedToday,
    });
  });

  it.each([
    ["today", DAY],
    ["the previous day", PREVIOUS_DAY],
  ] as const)("the board by driver has the same rows, %s", async (_, day) => {
    const board = await new DriverMonitoringUseCase(users, operation).execute({
      userId: MANAGER,
      day: day.date,
      now: CLOCK,
    });

    const summary = await read(CARRIER, day);

    expect(summary.drivers).toEqual(board.drivers);
  });
});

describe("the in-memory twins", () => {
  it.each(CASES)(
    "the delivery twin's backlog and reports are the database's, %s",
    async (_, businessId, day) => {
      const twin = await deliveryTwinFromDatabase();

      expect(await twin.operationBacklog(businessId, day)).toEqual(
        await deliveries.operationBacklog(businessId, day),
      );
    },
  );

  it.each(CASES)(
    "the pair the unit tests use reads the database's summary, %s",
    async (_, businessId, day) => {
      const twins = {
        operation: await operationTwinFromDatabase(),
        delivery: await deliveryTwinFromDatabase(),
      };

      expect(await readOperationSummary(twins, businessId, day)).toEqual(
        await read(businessId, day),
      );
    },
  );
});

describe("a delivery that points at another company's driver", () => {
  it("never prints that driver's name or CNH on the board", async () => {
    // The column has no tenant constraint; the lookup of names must have one.
    const id = await delivery("X-foreign-driver", {
      status: "IN_TRANSIT",
      driverId: OTHER_DRIVER,
    });

    try {
      const summary = await read(CARRIER, DAY);

      expect(summary.drivers).toContainEqual(
        expect.objectContaining({
          driverId: OTHER_DRIVER,
          driverName: "",
          cnh: "",
          inRoute: 1,
        }),
      );
    } finally {
      await prisma.delivery.delete({ where: { id } });
    }
  });
});
