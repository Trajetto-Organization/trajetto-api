import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A position batch sent twice, and a backlog older than the departure
 * (IDEMP-16).
 *
 * The app clears its buffer before posting and puts it back on failure, so a
 * response lost after the commit resends the same points. With a random id as
 * the only key, every resend stored the trail again: distance and time on the
 * route inflated, in the one record a dispute is settled with. And the route
 * was stamped at RECEPTION: a backlog from the morning's route, flushed after
 * the afternoon one started, was credited to the afternoon route.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdcb0-0000-7000-8000-00000000000a";

const MINUTE = 60_000;

let app: Awaited<typeof import("@/http")>["app"];

let driverId = "";
let driverToken = "";
let routeId = "";
let startedAt: Date;

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

const post = (pings: unknown[]) =>
  app.inject({
    method: "POST",
    url: "/route/positions",
    headers: { authorization: `Bearer ${driverToken}` },
    payload: { pings },
  });

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(56000000000000 + Math.floor(Math.random() * 9000000)),
  });

  driverId = seed.driverId;
  driverToken = seed.driverToken;

  startedAt = new Date(Date.now() - 10 * MINUTE);

  const route = await prisma.route.create({
    data: {
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: startedAt,
      businessId: CARRIER,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
    },
  });

  routeId = route.id;

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

describe("a batch resent after a lost response", () => {
  it("is stored once, and the resend says nothing was new", async () => {
    const now = Date.now();
    const pings = Array.from({ length: 5 }, (_, index) =>
      ping(new Date(now - (5 - index) * 15_000), index),
    );

    const first = await post(pings);
    const resend = await post(pings);

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({ stored: 5 });

    expect(resend.statusCode, resend.body).toBe(200);
    expect(resend.json().data).toMatchObject({ stored: 0, tracking: true });

    expect(await prisma.driverPosition.count({ where: { driverId } })).toBe(5);
  });
});

describe("a backlog from before this route left", () => {
  it("is kept in the trail but not credited to the route", async () => {
    const before = ping(new Date(startedAt.getTime() - MINUTE), 1);
    const after = ping(new Date(startedAt.getTime() + MINUTE), 2);

    const response = await post([before, after]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 2 });

    const trail = await prisma.driverPosition.findMany({
      where: { driverId },
      orderBy: { recorded_at: "asc" },
      select: { routeId: true },
    });

    expect(trail.map((row) => row.routeId)).toEqual([null, routeId]);
  });

  it("does not paint the map's last position with a route it was not on", async () => {
    const response = await post([
      ping(new Date(startedAt.getTime() - 2 * MINUTE), 3),
    ]);

    expect(response.statusCode, response.body).toBe(200);

    const [last] = await prisma.$queryRaw<Array<{ routeId: string | null }>>`
      SELECT "routeId" FROM "driver_last_position" WHERE "driverId" = ${driverId}
    `;

    expect(last.routeId).toBeNull();
  });
});
