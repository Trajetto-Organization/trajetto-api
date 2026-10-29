import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import type {
  IDriverPositionRepository,
  RecordedBatch,
} from "@/modules/route/repositories/IDriver-position-repository";
import type { AcceptedPing } from "@/shared/route/driver-position-rules";
import {
  businessDateKey,
  businessDayRange,
  dateOnlyFromKey,
} from "@/shared/time/business-day";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The positions repository against Postgres and against its in-memory twin
 * (decision 13.2, TWR-10).
 *
 * The same flushes go into both, in the same order, and every read is
 * written out by hand and then compared across the two: the dedupe on
 * (driverId, recorded_at), the last position that never moves backwards, the
 * half-open trail window at the company's midnight, and the tenant lock of
 * every read. The twin backs the tower's unit tests; if it drifted, those
 * tests would prove a tower that does not exist.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe0c0-0000-7000-8000-00000000000a";
const OTHER = "018fe0c0-0000-7000-8000-00000000000b";

const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;

// The company's day that contains now: its midnight is the trail's edge.
const DAY = businessDayRange(new Date(), ZONE);

const T = (minutes: number) => new Date(DAY.start.getTime() + minutes * MINUTE);

const DEPARTURE = T(30);

/**
 * Coordinates with four decimals, like a fix the app sends. A sum such as
 * -23.55 + 0.0005 is -23.549500000000002 in JavaScript, and the raw read
 * hands the double back at fifteen digits: a difference of float printing,
 * not of the repository, and not what this suite is about.
 */
const coordinate = (base: number, index: number) =>
  Number((base + index * 0.0001).toFixed(4));

function ping(at: Date, index: number): AcceptedPing {
  return {
    latitude: coordinate(-23.55, index),
    longitude: coordinate(-46.63, index),
    accuracy: 5 + index,
    speed: 30,
    heading: 90,
    battery: 80 - index,
    recorded_at: at,
  };
}

const database = new DriverPositionRepository();
const twin = new InMemoryDriverPositionRepository();

type Implementation = [string, IDriverPositionRepository];

const both = (): Implementation[] => [
  ["Postgres", database],
  ["in-memory", twin],
];

const batches: Record<string, RecordedBatch[]> = {
  Postgres: [],
  "in-memory": [],
};

let carrierDriver = "";
let otherDriver = "";
let routeId = "";
let plate = "";

beforeAll(async () => {
  const carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });
  const other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
  });

  carrierDriver = carrier.driverId;
  otherDriver = other.driverId;

  const route = await prisma.route.create({
    data: {
      code: 7,
      status: "IN_PROGRESS",
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), ZONE)),
      started_at: DEPARTURE,
      businessId: CARRIER,
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
    },
  });

  routeId = route.id;

  plate = (
    await prisma.vehicle.findUniqueOrThrow({
      where: { id: carrier.vehicleId },
      select: { license_plate: true },
    })
  ).license_plate;

  // What the map's joins read, copied from the rows Postgres joins.
  twin.drivers = await prisma.driver.findMany({
    where: { id: { in: [carrierDriver, otherDriver] } },
    select: { id: true, name: true, businessId: true },
  });
  twin.routes = [{ id: routeId, code: 7, vehiclePlate: plate }];

  // Yesterday's and today's partitions: the day's first minute before the
  // company's midnight may sit in either.
  const { driverPositionPartitionsJob } = await import(
    "@/jobs/cron/driver-position-partitions-job"
  );

  await driverPositionPartitionsJob.handler();

  for (const [name, repository] of both()) {
    const flush = (pings: AcceptedPing[]) =>
      repository.recordBatch({
        driverId: carrierDriver,
        businessId: CARRIER,
        routeId,
        routeStartedAt: DEPARTURE,
        pings,
      });

    // Out of order, across the company's midnight.
    batches[name].push(
      await flush([ping(T(0), 1), ping(T(-1), 0), ping(T(45), 2)]),
    );

    // A lost response: the same points again, and one new.
    batches[name].push(
      await flush([ping(T(0), 1), ping(T(45), 2), ping(T(50), 3)]),
    );

    // A backlog out of a dead zone, older than the last position.
    batches[name].push(await flush([ping(T(-1), 0), ping(T(40), 4)]));

    batches[name].push(
      await repository.recordBatch({
        driverId: otherDriver,
        businessId: OTHER,
        routeId: null,
        pings: [ping(T(10), 5)],
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("recording a flush", () => {
  it.each(both())("%s stores only what is new on a resend", async (name) => {
    expect(batches[name]).toEqual([
      { stored: 3, dropped: 0, advanced: true },
      { stored: 1, dropped: 0, advanced: true },
      // The backlog's newest point (T40) is older than the stored T50.
      { stored: 1, dropped: 0, advanced: false },
      { stored: 1, dropped: 0, advanced: true },
    ]);
  });
});

describe("the map", () => {
  const since = () => new Date(DAY.start.getTime() - 24 * 60 * MINUTE);

  it.each(both())(
    "%s keeps the newest position, never an older backlog",
    async (_name, repository) => {
      const latest = await repository.listLatestByBusiness(CARRIER, since());

      expect(latest).toEqual([
        {
          ...ping(T(50), 3),
          driverId: carrierDriver,
          routeId,
          driverName: "Motorista da Frota",
          vehiclePlate: plate,
          routeCode: 7,
        },
      ]);
    },
  );

  it.each(both())(
    "%s shows a company only its own drivers",
    async (_name, repository) => {
      const latest = await repository.listLatestByBusiness(OTHER, since());

      expect(
        latest.map((row) => [row.driverId, row.routeId, row.routeCode]),
      ).toEqual([[otherDriver, null, null]]);

      // Nothing after the newest point.
      expect(
        await repository.listLatestByBusiness(
          CARRIER,
          new Date(T(50).getTime() + 1),
        ),
      ).toEqual([]);
    },
  );

  it("gives the same map from both", async () => {
    for (const businessId of [CARRIER, OTHER]) {
      const [fromDatabase, fromTwin] = await Promise.all([
        database.listLatestByBusiness(businessId, since()),
        twin.listLatestByBusiness(businessId, since()),
      ]);

      expect(fromDatabase).toEqual(fromTwin);
    }
  });
});

describe("the last signal of a quiet driver", () => {
  it.each(both())(
    "%s answers only for the company's drivers",
    async (_name, repository) => {
      const signals = await repository.listLastSignals(CARRIER, [
        carrierDriver,
        otherDriver,
        randomUUID(),
      ]);

      expect(signals).toEqual([
        { driverId: carrierDriver, recorded_at: T(50) },
      ]);
      expect(await repository.listLastSignals(CARRIER, [])).toEqual([]);
      expect(await repository.listLastSignals(OTHER, [carrierDriver])).toEqual(
        [],
      );
    },
  );
});

describe("the trail of the day", () => {
  it.each(both())(
    "%s starts at the company's midnight, and the window is half-open",
    async (_name, repository) => {
      const day = await repository.listTrail({
        businessId: CARRIER,
        driverId: carrierDriver,
        from: DAY.start,
        to: DAY.end,
      });

      // T(-1) is yesterday's; T(0) is today's first. Before the departure a
      // point is not the route's.
      expect(
        day.map((point) => [point.recorded_at.toISOString(), point.routeId]),
      ).toEqual([
        [T(0).toISOString(), null],
        [T(40).toISOString(), routeId],
        [T(45).toISOString(), routeId],
        [T(50).toISOString(), routeId],
      ]);

      const cut = await repository.listTrail({
        businessId: CARRIER,
        driverId: carrierDriver,
        from: T(-1),
        to: T(50),
      });

      expect(cut.map((point) => point.recorded_at.toISOString())).toEqual([
        T(-1).toISOString(),
        T(0).toISOString(),
        T(40).toISOString(),
        T(45).toISOString(),
      ]);
    },
  );

  it.each(both())(
    "%s never reads another company's trail",
    async (_name, repository) => {
      expect(
        await repository.listTrail({
          businessId: OTHER,
          driverId: carrierDriver,
          from: T(-60),
          to: DAY.end,
        }),
      ).toEqual([]);
    },
  );

  it("gives the same trail from both", async () => {
    const window = {
      businessId: CARRIER,
      driverId: carrierDriver,
      from: T(-60),
      to: DAY.end,
    };

    const [fromDatabase, fromTwin] = await Promise.all([
      database.listTrail(window),
      twin.listTrail(window),
    ]);

    expect(fromDatabase).toHaveLength(5);
    expect(fromDatabase).toEqual(fromTwin);
  });
});

describe("whose driver it is", () => {
  it.each(both())(
    "%s knows only the company's drivers",
    async (_name, repository) => {
      expect(await repository.hasDriver(CARRIER, carrierDriver)).toBe(true);
      expect(await repository.hasDriver(CARRIER, otherDriver)).toBe(false);
      expect(await repository.hasDriver(CARRIER, randomUUID())).toBe(false);
    },
  );
});

describe("the route page's reads (decision 14.7)", () => {
  it.each(both())(
    "%s narrows the trail to one route",
    async (_name, repository) => {
      const trail = await repository.listTrail({
        businessId: CARRIER,
        driverId: carrierDriver,
        routeId,
        from: T(-60),
        to: DAY.end,
      });

      // The point before the departure carries no route and stays out.
      expect(trail.map((point) => point.recorded_at.toISOString())).toEqual([
        T(40).toISOString(),
        T(45).toISOString(),
        T(50).toISOString(),
      ]);
    },
  );

  it.each(both())(
    "%s answers the last point within the company only",
    async (_name, repository) => {
      const last = await repository.findLast(CARRIER, carrierDriver);

      expect(last).toMatchObject({ routeId, recorded_at: T(50) });

      expect(await repository.findLast(OTHER, carrierDriver)).toBeNull();
    },
  );

  it("gives the same last point from both", async () => {
    expect(await database.findLast(CARRIER, carrierDriver)).toEqual(
      await twin.findLast(CARRIER, carrierDriver),
    );
  });
});
