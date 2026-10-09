import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * What one flush of the driver's phone costs the database.
 *
 * POST /route/positions is the hottest route in the product: every driver on
 * the road flushes every two minutes (or every twenty points). Measured
 * before this test, one flush of a driver with a 40-stop route ran sixteen
 * statements, and only two of them were the writes it exists for:
 *
 *   - the session loaded the user (user, business, entitlements, driver),
 *     then loaded the driver AGAIN with its branch and its user just to read
 *     the status and the branch switch;
 *   - the module gate re-read the entitlements the session had just loaded;
 *   - the use case loaded the whole route — driver, vehicle, every stop and
 *     every delivery — to read two fields, its id and its status.
 *
 * The statements are counted on the app's own client: a logging client is put
 * in place of the singleton BEFORE the app is imported, so every repository
 * and middleware talks through it.
 */
const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdd30-0000-7000-8000-00000000000a";

const statements: string[] = [];

let driverToken = "";

function pings(count: number) {
  const now = Date.now();

  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55 + index * 0.0001,
    longitude: -46.63 + index * 0.0001,
    accuracy: 10,
    speed: 30,
    heading: 90,
    battery: 80,
    recorded_at: new Date(now - (count - index) * 15_000).toISOString(),
  }));
}

/** Statements that read FROM a table, by its quoted name. */
function readsOf(table: string): string[] {
  return statements.filter(
    (sql) =>
      /^\s*SELECT/i.test(sql) && sql.includes(`FROM "public"."${table}"`),
  );
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(56000000000000 + Math.floor(Math.random() * 9000000)),
  });

  driverToken = seed.driverToken;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });

  const route = await prisma.route.create({
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

  // Forty stops, each with its delivery: the size of a real day, and what
  // the old route load dragged into every flush.
  for (let index = 0; index < 40; index++) {
    const delivery = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: shipper.id,
        code: `ORC-${index}`,
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "IN_TRANSIT",
        driverId: seed.driverId,
      },
    });

    await prisma.routeStop.create({
      data: { routeId: route.id, deliveryId: delivery.id, sequence: index + 1 },
    });
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("one flush of positions from the driver's phone", () => {
  it("stores the points without reloading what the session already knows", async () => {
    statements.length = 0;

    const response = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { pings: pings(20) },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 20, tracking: true });

    const trace = statements.join("\n");

    // The route is asked for its id, not rebuilt with every stop and
    // delivery.
    expect(readsOf("route_stop"), trace).toEqual([]);
    expect(readsOf("delivery"), trace).toEqual([]);
    expect(readsOf("vehicle"), trace).toEqual([]);

    // The session's own snapshot answers the module gate and the driver's
    // eligibility: each is read once per request, not twice.
    expect(readsOf("business_entitlement"), trace).toHaveLength(1);
    expect(readsOf("driver"), trace).toHaveLength(1);

    // user, business, entitlements, driver, branch, the refresh-token
    // family, the running route, and the two writes (the points and the
    // driver's last position). Nine; it was sixteen. The BEGIN/COMMIT Prisma
    // wraps around the createMany are not work of their own.
    const work = statements.filter(
      (sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql),
    );

    expect(work.length, trace).toBeLessThanOrEqual(9);
  });
});
