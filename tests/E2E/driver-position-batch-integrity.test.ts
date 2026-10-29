import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * One flush of positions is stored whole or not at all, and one point the
 * table cannot hold does not take the rest of the flush with it (INV-14,
 * GAP3-14).
 *
 * Two defects, one write path:
 *
 * - The trail insert and the driver_last_position upsert were two statements
 *   with no transaction, under a comment claiming "the same commit". When the
 *   second failed, the trail kept points the map never showed, and the resend
 *   the phone makes after the 5xx met them again.
 *
 * - driver_position is range-partitioned by day with no DEFAULT partition,
 *   so a row with no partition is REFUSED, and the refusal fails the whole
 *   INSERT. The API accepts points up to 89 days old, but the oldest partition
 *   is the day before the migration ran — a phone flushing a backlog that
 *   reached back past it got a 500 for all of it, kept the batch, and sent it
 *   again forever.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdd31-0000-7000-8000-00000000000a";

const DAY_MS = 24 * 60 * 60 * 1000;

let app: Awaited<typeof import("@/http")>["app"];

let driverId = "";
let driverToken = "";

function ping(recordedAt: Date, index = 0) {
  return {
    latitude: -23.55 + index * 0.0001,
    longitude: -46.63 + index * 0.0001,
    accuracy: 10,
    speed: 30,
    heading: 90,
    battery: 80,
    recorded_at: recordedAt.toISOString(),
  };
}

function freshPings(count: number) {
  const now = Date.now();

  // Distinct instants: (driverId, recorded_at) is unique, and a repeated
  // instant would be absorbed as a resend rather than stored.
  return Array.from({ length: count }, (_, index) =>
    ping(
      new Date(
        now - (count - index) * 15_000 - Math.floor(Math.random() * 1000),
      ),
      index,
    ),
  );
}

const post = (pings: unknown[]) =>
  app.inject({
    method: "POST",
    url: "/route/positions",
    headers: { authorization: `Bearer ${driverToken}` },
    payload: { pings },
  });

const trailSize = () => prisma.driverPosition.count({ where: { driverId } });

function utcMidnight(offsetDays: number): Date {
  const day = new Date();

  day.setUTCHours(0, 0, 0, 0);

  return new Date(day.getTime() + offsetDays * DAY_MS);
}

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });

  driverId = seed.driverId;
  driverToken = seed.driverToken;

  await prisma.route.create({
    data: {
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: new Date(Date.now() - 60 * 60_000),
      businessId: CARRIER,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

beforeEach(async () => {
  await prisma.driverPosition.deleteMany({ where: { driverId } });
  await prisma.$executeRaw`DELETE FROM "driver_last_position" WHERE "driverId" = ${driverId}`;
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a flush with a point older than every partition", () => {
  it("stores the rest and drops only that point", async () => {
    // Thirty days back: inside the 89 days the API accepts, and far before
    // the day the test database's first partition covers.
    const ancient = ping(new Date(Date.now() - 30 * DAY_MS));

    const response = await post([...freshPings(5), ancient]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 5, tracking: true });
    expect(response.json().data.rejected).toBeGreaterThanOrEqual(1);

    expect(await trailSize()).toBe(5);
  });

  it("answers 200 with nothing stored when no point had a partition", async () => {
    const response = await post([
      ping(new Date(Date.now() - 40 * DAY_MS)),
      ping(new Date(Date.now() - 41 * DAY_MS)),
    ]);

    // A 5xx here is the phone resending the same two points forever.
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 0, rejected: 2 });

    expect(await trailSize()).toBe(0);
  });
});

describe("a flush whose last-position write fails", () => {
  it("leaves no trail behind: both writes commit together or not at all", async () => {
    // Refuses the second write of the flush, and only for this driver.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "refuse_last_position_for_test"() RETURNS trigger AS $$
      BEGIN
        IF NEW."driverId" = '${driverId}' THEN
          RAISE EXCEPTION 'last position refused by the test';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "refuse_last_position_for_test"
        BEFORE INSERT OR UPDATE ON "driver_last_position"
        FOR EACH ROW EXECUTE FUNCTION "refuse_last_position_for_test"()
    `);

    try {
      const response = await post(freshPings(5));

      expect(response.statusCode).toBeGreaterThanOrEqual(500);

      // The assertion this block exists for: before, the five points stayed
      // in the trail while the map kept the old dot.
      expect(await trailSize()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "refuse_last_position_for_test" ON "driver_last_position"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "refuse_last_position_for_test"()`,
      );
    }

    // And the same flush goes through once the fault is gone.
    const retried = await post(freshPings(5));

    expect(retried.statusCode, retried.body).toBe(200);
    expect(await trailSize()).toBe(5);
  });
});

describe("a flush for a day whose partition is still to be created", () => {
  it("fails loudly and keeps the points on the phone instead of dropping them", async () => {
    // Today's partition gone is the partition job having missed its whole
    // runway. The next run creates it (it starts from yesterday), so these
    // points are NOT unwritable — a 200 that dropped them would throw away a
    // day of every driver's trail in silence.
    const today = utcMidnight(0);
    const name = `driver_position_${today.toISOString().slice(0, 10).replace(/-/g, "")}`;

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "driver_position" DETACH PARTITION "${name}"`,
    );

    try {
      // A minute ago, but never before today's midnight: right after it, a
      // second into today (the API accepts five minutes of clock skew).
      const inToday = new Date(
        Math.max(Date.now() - 60_000, today.getTime() + 1_000),
      );

      const response = await post([ping(inToday)]);

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "driver_position" ATTACH PARTITION "${name}"
           FOR VALUES FROM ('${today.toISOString()}') TO ('${utcMidnight(1).toISOString()}')`,
      );
    }
  });
});
