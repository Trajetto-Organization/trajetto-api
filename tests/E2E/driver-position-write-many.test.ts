import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import type {
  PositionWrite,
  RecordedBatch,
} from "@/modules/route/repositories/IDriver-position-repository";
import {
  isMissingPartition,
  type AcceptedPing,
} from "@/shared/route/driver-position-rules";
import { businessDayRange } from "@/shared/time/business-day";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Many flushes in one transaction (plano-escala F5-18), the write of the
 * GPS group commit.
 *
 * The contract is recordBatch's, one flush after the other: the same
 * answers and the same rows. The in-memory twin runs the flushes exactly
 * that way, and driver-position-contract.test.ts holds the twin to
 * recordBatch on Postgres, so each case here compares the one transaction
 * with the twin: a point two flushes share (counted by the first), a
 * backlog older than the last position, two flushes of one driver at one
 * instant, a last position already stored, an empty flush.
 *
 * Then what a batch adds to the hot path: two replicas writing the same
 * drivers at once must wait for each other, never deadlock; and one point
 * no partition holds must leave nothing written, so each flush can be
 * redone on its own by recordBatch.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe0c1-0000-7000-8000-00000000000a";

const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;

const DAY = businessDayRange(new Date(), ZONE);

const T = (minutes: number) => new Date(DAY.start.getTime() + minutes * MINUTE);

const DEPARTURE = T(30);

const coordinate = (base: number, index: number) =>
  Number((base + index * 0.0001).toFixed(4));

function ping(at: Date, index: number): AcceptedPing {
  return {
    latitude: coordinate(-23.55, index),
    longitude: coordinate(-46.63, index),
    accuracy: index % 2 === 0 ? 5 + index : null,
    speed: index % 3 === 0 ? null : 30.5,
    heading: 90,
    battery: index % 4 === 0 ? null : 80 - index,
    recorded_at: at,
  };
}

const database = new DriverPositionRepository();

let branchId = "";
let routeId = "";
const drivers: string[] = [];

async function newDriver(): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      name: "Motorista do Lote",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
      branchId,
    },
  });

  return driver.id;
}

/** The trail and the last positions of these drivers, as Postgres has them. */
async function rowsOf(ids: string[]) {
  const trail = await prisma.driverPosition.findMany({
    where: { driverId: { in: ids } },
    orderBy: [{ driverId: "asc" }, { recorded_at: "asc" }],
    select: {
      driverId: true,
      businessId: true,
      routeId: true,
      latitude: true,
      longitude: true,
      accuracy: true,
      speed: true,
      heading: true,
      battery: true,
      recorded_at: true,
    },
  });

  const last = await prisma.driverLastPosition.findMany({
    where: { driverId: { in: ids } },
    orderBy: { driverId: "asc" },
    select: {
      driverId: true,
      businessId: true,
      routeId: true,
      latitude: true,
      longitude: true,
      accuracy: true,
      speed: true,
      heading: true,
      battery: true,
      recorded_at: true,
    },
  });

  return { trail, last };
}

/** The same, as the twin has them. */
function twinRowsOf(twin: InMemoryDriverPositionRepository, ids: string[]) {
  const byKey = (
    a: { driverId: string; recorded_at: Date },
    b: { driverId: string; recorded_at: Date },
  ) =>
    a.driverId === b.driverId
      ? a.recorded_at.getTime() - b.recorded_at.getTime()
      : a.driverId < b.driverId
        ? -1
        : 1;

  return {
    trail: twin.trail
      .filter((row) => ids.includes(row.driverId))
      .sort(byKey)
      .map((row) => ({ ...row })),
    last: [...twin.last.values()]
      .filter((row) => ids.includes(row.driverId))
      .sort(byKey)
      .map((row) => ({ ...row })),
  };
}

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
  });

  branchId = seed.branchId;
  drivers.push(seed.driverId);

  for (let index = 0; index < 5; index += 1) drivers.push(await newDriver());

  const route = await prisma.route.create({
    data: {
      code: 11,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: DEPARTURE,
      businessId: CARRIER,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
    },
  });

  routeId = route.id;

  // Yesterday's and today's partitions: the first flush crosses midnight.
  const { partitionMaintenanceJob } =
    await import("@/jobs/cron/partition-maintenance-job");

  await partitionMaintenanceJob.handler();
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("many flushes in one transaction", () => {
  it("answers each flush, and leaves the rows, as recordBatch one after the other", async () => {
    const [onRoute, quiet, idle] = drivers;
    const twin = new InMemoryDriverPositionRepository();

    // A last position already stored, older than the batch's.
    const before: PositionWrite = {
      driverId: quiet,
      businessId: CARRIER,
      routeId: null,
      pings: [ping(T(7), 20)],
    };

    expect(await database.recordBatch(before)).toEqual(
      await twin.recordBatch(before),
    );

    const writes: PositionWrite[] = [
      // Across the company's midnight, before and after the departure.
      {
        driverId: onRoute,
        businessId: CARRIER,
        routeId,
        routeStartedAt: DEPARTURE,
        pings: [ping(T(0), 1), ping(T(-1), 0), ping(T(45), 2)],
      },
      {
        driverId: quiet,
        businessId: CARRIER,
        routeId: null,
        pings: [ping(T(10), 3)],
      },
      // A point the first flush has, and one newer.
      {
        driverId: onRoute,
        businessId: CARRIER,
        routeId,
        routeStartedAt: DEPARTURE,
        pings: [ping(T(0), 1), ping(T(50), 4)],
      },
      // A backlog older than the driver's newest of the batch.
      {
        driverId: onRoute,
        businessId: CARRIER,
        routeId,
        routeStartedAt: DEPARTURE,
        pings: [ping(T(40), 5)],
      },
      { driverId: idle, businessId: CARRIER, routeId: null, pings: [] },
      // A resend of the quiet driver's point, and one older than it.
      {
        driverId: quiet,
        businessId: CARRIER,
        routeId: null,
        pings: [ping(T(10), 3), ping(T(5), 6)],
      },
      // The same instant as the newest, other coordinates: not newer.
      {
        driverId: onRoute,
        businessId: CARRIER,
        routeId,
        routeStartedAt: DEPARTURE,
        pings: [ping(T(50), 9)],
      },
    ];

    const fromDatabase = await database.writeBatchMany(writes);
    const fromTwin = await twin.writeBatchMany(writes);

    expect(fromTwin).toEqual<RecordedBatch[]>([
      { stored: 3, dropped: 0, advanced: true },
      { stored: 1, dropped: 0, advanced: true },
      { stored: 1, dropped: 0, advanced: true },
      { stored: 1, dropped: 0, advanced: false },
      { stored: 0, dropped: 0, advanced: false },
      { stored: 1, dropped: 0, advanced: false },
      { stored: 0, dropped: 0, advanced: false },
    ]);
    expect(fromDatabase).toEqual(fromTwin);

    const ids = [onRoute, quiet, idle];

    expect(await rowsOf(ids)).toEqual(twinRowsOf(twin, ids));
  });

  it("answers an empty list, and a list of empty flushes, without writing", async () => {
    expect(await database.writeBatchMany([])).toEqual([]);
    expect(
      await database.writeBatchMany([
        { driverId: drivers[2], businessId: CARRIER, routeId: null, pings: [] },
      ]),
    ).toEqual([{ stored: 0, dropped: 0, advanced: false }]);
  });
});

describe("two replicas writing the same drivers at once", () => {
  it("wait for each other and never deadlock", async () => {
    const [first, second] = [drivers[3], drivers[4]];

    for (let round = 0; round < 15; round += 1) {
      const base = 60 + round * 10;
      const points = (index: number) =>
        [0, 1, 2, 3].map((step) => ping(T(base + step), index + step));

      const forward: PositionWrite[] = [
        {
          driverId: first,
          businessId: CARRIER,
          routeId: null,
          pings: points(1),
        },
        {
          driverId: second,
          businessId: CARRIER,
          routeId: null,
          pings: points(2),
        },
      ];

      // The other replica got the same flushes the other way round, each
      // body reversed; and a third flush goes through recordBatch.
      const backward: PositionWrite[] = [...forward]
        .reverse()
        .map((write) => ({ ...write, pings: [...write.pings].reverse() }));

      const [a, b, c] = await Promise.all([
        database.writeBatchMany(forward),
        database.writeBatchMany(backward),
        database.recordBatch({
          ...forward[0],
          pings: [...forward[0].pings].reverse(),
        }),
      ]);

      // Each point once across the three: whoever committed first stored it.
      expect(a[0].stored + b[1].stored + c.stored, `round ${round}`).toBe(4);
      expect(a[1].stored + b[0].stored, `round ${round}`).toBe(4);
    }

    expect(
      await prisma.driverPosition.count({
        where: { driverId: { in: [first, second] } },
      }),
    ).toBe(15 * 4 * 2);
  }, 120_000);
});

describe("a point no partition holds", () => {
  it("fails the whole batch, writes nothing, and recordBatch then stores each flush", async () => {
    const [stale, fresh] = [drivers[5], drivers[1]];

    const longAgo = new Date(Date.now() - 400 * 24 * 60 * MINUTE);

    const writes: PositionWrite[] = [
      {
        driverId: fresh,
        businessId: CARRIER,
        routeId: null,
        pings: [ping(T(200), 30)],
      },
      {
        driverId: stale,
        businessId: CARRIER,
        routeId: null,
        pings: [ping(longAgo, 31), ping(T(201), 32)],
      },
    ];

    const failure = await database.writeBatchMany(writes).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isMissingPartition(failure), String(failure)).toBe(true);

    const nothing = await prisma.driverPosition.count({
      where: {
        driverId: { in: [fresh, stale] },
        recorded_at: { gte: T(200) },
      },
    });

    expect(nothing).toBe(0);

    // The group commit's fallback: each flush on its own, as before it.
    expect(await database.recordBatch(writes[0])).toEqual({
      stored: 1,
      dropped: 0,
      advanced: true,
    });
    expect(await database.recordBatch(writes[1])).toEqual({
      stored: 1,
      dropped: 1,
      advanced: true,
    });
  });
});
