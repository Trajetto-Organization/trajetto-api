import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

/**
 * The control tower against a real database, including the thing that only a
 * real database has: partitions.
 *
 * `driver_position` is the one table in the product that grows with TIME. It
 * is partitioned by day from the start, and a partitioned table is not a
 * detail a unit test can stand in for — a row with no partition for its day is
 * REFUSED by Postgres, which is a failure that appears at midnight and nowhere
 * else.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f9000-0000-7000-8000-00000000000a";
const OTHER = "018f9000-0000-7000-8000-00000000000b";

const MANAGER = "018f9000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f9000-0000-7000-8000-0000000000a2";

const DRIVER = "018f9000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f9000-0000-7000-8000-0000000000d2";

const VEHICLE = "018f9000-0000-7000-8000-0000000000c1";
const SHIPPER = "018f9000-0000-7000-8000-0000000000f1";

let managerToken: string;
let driverToken: string;

let routeId: string;

/**
 * A session, minted locally.
 *
 * The same shape `ensure-authenticated` verifies: a refresh-token family has
 * to exist, and the claims carry the session version. Nobody's password is
 * touched.
 */
async function tokenFor(userId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(id: string, businessId: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${id.slice(-6)}`,
      cpf: `cpf-${id.slice(-6)}`,
      rg: `rg-${id.slice(-6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

/** Points the app would have buffered, oldest first. */
function pings(count: number, options: { at?: Date; accuracy?: number } = {}) {
  const at = options.at ?? new Date();

  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55 + index * 0.0001,
    longitude: -46.63 + index * 0.0001,
    accuracy: options.accuracy ?? 10,
    speed: 30,
    heading: 90,
    battery: 80,
    recorded_at: new Date(at.getTime() - (count - index) * 15_000).toISOString(),
  }));
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "11222888000166");
  await seedBusiness(OTHER, "11222888000155");

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(OTHER_DRIVER, OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  await prisma.vehicle.create({
    data: {
      id: VEHICLE,
      description: "Caminhão",
      license_plate: `TWR1A${Math.floor(Math.random() * 90) + 10}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-torre-${Math.floor(Math.random() * 100000)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      driverId: DRIVER,
      fuelTypeId: fuelType.id,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.user.create({
    data: {
      id: DRIVER_USER,
      name: "Motorista",
      email: `motorista-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
    },
  });

  managerToken = await tokenFor(MANAGER);
  driverToken = await tokenFor(DRIVER_USER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

beforeEach(async () => {
  await prisma.driverLastPosition.deleteMany({ where: { businessId: CARRIER } });
  await prisma.driverPosition.deleteMany({ where: { businessId: CARRIER } });
  await prisma.routeStop.deleteMany({});
  await prisma.route.deleteMany({ where: { businessId: CARRIER } });

  const route = await prisma.route.create({
    data: {
      code: Math.floor(Math.random() * 100000),
      name: "Rota da torre",
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      planned_departure_at: new Date(Date.now() - 60 * 60 * 1000),
      started_at: new Date(Date.now() - 55 * 60 * 1000),
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: VEHICLE,
    },
  });

  routeId = route.id;
});

afterAll(async () => {
  await prisma.driverLastPosition.deleteMany({});
  await prisma.driverPosition.deleteMany({});
  await prisma.routeStop.deleteMany({});
  await prisma.route.deleteMany({});
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [MANAGER, DRIVER_USER] } },
  });

  await prisma.user.deleteMany({ where: { id: { in: [MANAGER, DRIVER_USER] } } });
  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.driver.deleteMany({ where: { id: { in: [DRIVER, OTHER_DRIVER] } } });
  await prisma.shipper.deleteMany({ where: { businessId: CARRIER } });

  await prisma.fuelType.deleteMany({ where: { businessId: CARRIER } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });

  await prisma.business.deleteMany({ where: { id: { in: [CARRIER, OTHER] } } });

  await app?.close();
  await prisma.$disconnect();
});

const post = (url: string, token: string, body: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as never,
  });

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("the partitioned table", () => {
  it("has a partition for today, and the row lands in it", async () => {
    // The whole design rests on this. A range-partitioned table with no
    // partition for a row does not warn — it refuses the insert, and the first
    // ping after midnight would be the one that discovers it.
    const response = await post("/route/positions", driverToken, {
      pings: pings(3),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.stored).toBe(3);

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
      `SELECT count(*)::bigint AS total FROM "driver_position_${today}"`,
    );

    expect(Number(rows[0].total)).toBe(3);
  });

  it("keeps the parent readable as one table", async () => {
    // A partitioned parent that could not be queried whole would make every
    // reader partition-aware, which is the thing partitioning is supposed to
    // hide.
    await post("/route/positions", driverToken, { pings: pings(2) });

    expect(
      await prisma.driverPosition.count({ where: { businessId: CARRIER } }),
    ).toBe(2);
  });
});

describe("who may write a position", () => {
  it("takes the driver from the session and not from the body", async () => {
    const response = await post("/route/positions", driverToken, {
      pings: pings(1),

      // Ignored by the schema. If it were not, any phone could write
      // anybody's trail — and a trail is what a dispute is settled with.
      driverId: OTHER_DRIVER,
    } as never);

    expect(response.statusCode).toBe(200);

    const stored = await prisma.driverPosition.findMany({
      where: { businessId: CARRIER },
      select: { driverId: true },
    });

    expect(stored.every((row) => row.driverId === DRIVER)).toBe(true);
  });

  it("refuses a manager pretending to be a phone", async () => {
    const response = await post("/route/positions", managerToken, {
      pings: pings(1),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("aplicativo do motorista");
  });

  it("stops tracking when no route is running", async () => {
    await prisma.route.update({
      where: { id: routeId },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    const response = await post("/route/positions", driverToken, {
      pings: pings(5),
    });

    // Not an error: the app asks by sending, and the answer travels back in
    // the same round trip so it can stop without a second call.
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 0, tracking: false });

    expect(
      await prisma.driverPosition.count({ where: { businessId: CARRIER } }),
    ).toBe(0);
  });
});

describe("what a phone sends and what survives", () => {
  it("accepts a backlog whole and drops only the unusable points", async () => {
    const usable = pings(4);
    const unusable = [
      { ...usable[0], accuracy: 800 },
      { ...usable[0], latitude: 0, longitude: 0 },
    ];

    const response = await post("/route/positions", driverToken, {
      pings: [...usable, ...unusable],
    });

    expect(response.json().data).toMatchObject({ stored: 4, rejected: 2 });
  });

  it("keeps the device's own clock, not the arrival time", async () => {
    // A driver crosses a dead zone and the app flushes twenty points at once.
    // Stamping them on arrival would collapse half an hour of road into one
    // instant — and the trail would draw a straight line through it.
    const recordedAt = new Date(Date.now() - 20 * 60 * 1000);

    await post("/route/positions", driverToken, {
      pings: [
        {
          latitude: -23.55,
          longitude: -46.63,
          accuracy: 10,
          recorded_at: recordedAt.toISOString(),
        },
      ],
    });

    const stored = await prisma.driverPosition.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(
      Math.abs(stored.recorded_at.getTime() - recordedAt.getTime()),
    ).toBeLessThan(1000);

    expect(stored.created_at.getTime()).toBeGreaterThan(
      stored.recorded_at.getTime(),
    );
  });
});

describe("the tower a manager opens", () => {
  it("shows one dot per driver, not one per ping", async () => {
    await post("/route/positions", driverToken, { pings: pings(30) });

    const response = await get("/route/control-tower", managerToken);

    expect(response.statusCode).toBe(200);

    const { positions } = response.json().data;

    // Thirty points, one truck. A map that drew every ping would be a map of
    // a single street and nothing else.
    expect(positions).toHaveLength(1);
    expect(positions[0].driverId).toBe(DRIVER);
    expect(positions[0].fresh).toBe(true);

    // Named, so the dispatcher can act on it without a second lookup.
    expect(positions[0].driverName).toBeTruthy();
    expect(positions[0].routeCode).toBeGreaterThan(0);
  });

  it("shows the LATEST point of a driver", async () => {
    await post("/route/positions", driverToken, { pings: pings(10) });

    const response = await get("/route/control-tower", managerToken);
    const [position] = response.json().data.positions;

    const latest = await prisma.driverPosition.findFirstOrThrow({
      where: { businessId: CARRIER },
      orderBy: { recorded_at: "desc" },
    });

    expect(position.latitude).toBeCloseTo(latest.latitude, 6);
  });

  it("answers the punctuality of the day honestly", async () => {
    const response = await get("/route/control-tower", managerToken);
    const { punctuality } = response.json().data;

    // Planned an hour ago, departed fifty-five minutes ago: five minutes
    // early, which nobody would call late.
    expect(punctuality.onTime).toBe(1);
    expect(punctuality.rate).toBe(100);
  });

  it("refuses to score a day where nothing was planned", async () => {
    await prisma.route.update({
      where: { id: routeId },
      data: { planned_departure_at: null },
    });

    const response = await get("/route/control-tower", managerToken);

    // Null and not 100%: an operation that plans no departures would otherwise
    // score a perfect record for having no plan.
    expect(response.json().data.punctuality.rate).toBeNull();
    expect(response.json().data.punctuality.notPlanned).toBe(1);
  });

  it("shows the funnel with a zero for what did not happen", async () => {
    const { funnel } = (await get("/route/control-tower", managerToken)).json()
      .data;

    expect(funnel.map((entry: { status: string }) => entry.status)).toEqual([
      "PENDING",
      "IN_TRANSIT",
      "DELIVERED",
      "FAILED",
      "CANCELLED",
    ]);

    // "Nenhuma entrega falhou hoje" is the best thing this screen can say, and
    // a funnel missing the column could never say it.
    expect(funnel.find((entry: { status: string }) => entry.status === "FAILED"))
      .toMatchObject({ total: 0 });
  });

  it("refuses a driver token", async () => {
    const response = await get("/route/control-tower", driverToken);

    // The app's permission table opens delivery_manage for the driver's own
    // work. The whole operation is the manager's.
    expect(response.statusCode).toBe(403);
  });
});

describe("one company's trucks are not another's", () => {
  it("never shows a position from another carrier", async () => {
    await post("/route/positions", driverToken, { pings: pings(2) });

    // Written straight into the table, as a second carrier's phone would.
    await prisma.driverLastPosition.create({
      data: {
        driverId: OTHER_DRIVER,
        businessId: OTHER,
        latitude: -22.9,
        longitude: -43.2,
        recorded_at: new Date(),
      },
    });

    const { positions } = (await get("/route/control-tower", managerToken))
      .json().data;

    expect(positions).toHaveLength(1);
    expect(positions[0].driverId).toBe(DRIVER);
  });

  it("answers 404 for a driver of another carrier's trail", async () => {
    const response = await get(
      `/route/driver-trail/${OTHER_DRIVER}`,
      managerToken,
    );

    // The same 404 as one that does not exist. A distinct "exists but is not
    // yours" tells somebody which ids are real.
    expect(response.statusCode).toBe(404);
  });
});

describe("the trail of one driver", () => {
  it("thins the day down and says how many there really were", async () => {
    // Two full batches: more points than the trail will draw.
    await post("/route/positions", driverToken, { pings: pings(500) });
    await post("/route/positions", driverToken, {
      pings: pings(500, { at: new Date(Date.now() - 500 * 15_000) }),
    });

    const response = await get(`/route/driver-trail/${DRIVER}`, managerToken);

    expect(response.statusCode).toBe(200);

    const trail = response.json().data;

    expect(trail.recorded).toBe(1000);
    expect(trail.points).toHaveLength(400);

    // A screen that showed only what it drew would have somebody conclude the
    // phone stopped reporting.
    expect(trail.recorded).toBeGreaterThan(trail.points.length);
  });

  it("returns the points in order, ending where the driver ended", async () => {
    await post("/route/positions", driverToken, { pings: pings(50) });

    const trail = (
      await get(`/route/driver-trail/${DRIVER}`, managerToken)
    ).json().data;

    const times = trail.points.map((point: { recordedAt: string }) =>
      new Date(point.recordedAt).getTime(),
    );

    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThan(times[index - 1]);
    }

    const latest = await prisma.driverPosition.findFirstOrThrow({
      where: { businessId: CARRIER },
      orderBy: { recorded_at: "desc" },
    });

    expect(times[times.length - 1]).toBe(latest.recorded_at.getTime());
  });

  it("answers an empty day without inventing a line", async () => {
    const trail = (
      await get(`/route/driver-trail/${DRIVER}?day=2026-01-01`, managerToken)
    ).json().data;

    expect(trail.recorded).toBe(0);
    expect(trail.points).toEqual([]);
  });
});

describe("keeping the partitions ahead of the trucks", () => {
  async function attachedPartitions(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(`
      SELECT child.relname::text AS relname
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'driver_position'
      ORDER BY child.relname
    `);

    return rows.map((row) => row.relname);
  }

  function nameFor(offsetDays: number): string {
    const day = new Date();

    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + offsetDays);

    return `driver_position_${day.toISOString().slice(0, 10).replace(/-/g, "")}`;
  }

  it("creates the week ahead, so a missed night costs nothing", async () => {
    const { driverPositionPartitionsJob, PARTITION_LOOKAHEAD_DAYS } =
      await import("@/jobs/cron/driver-position-partitions-job");

    await driverPositionPartitionsJob.handler();

    const partitions = await attachedPartitions();

    // A job that only ever created tomorrow's would have no slack: one missed
    // night and the first ping of the day is REFUSED, not warned about.
    for (let offset = -1; offset <= PARTITION_LOOKAHEAD_DAYS; offset += 1) {
      expect(partitions, `offset ${offset}`).toContain(nameFor(offset));
    }
  });

  it("runs twice without complaining", async () => {
    const { driverPositionPartitionsJob } = await import(
      "@/jobs/cron/driver-position-partitions-job"
    );

    // Two replicas run this at the same second. The race between "does it
    // exist" and "create it" is exactly the kind that only shows up in
    // production.
    await driverPositionPartitionsJob.handler();
    await expect(driverPositionPartitionsJob.handler()).resolves.not.toThrow();
  });

  it("drops a day past the retention, and only that day", async () => {
    const { driverPositionPartitionsJob, PARTITION_RETENTION_DAYS } =
      await import("@/jobs/cron/driver-position-partitions-job");

    const stale = nameFor(-(PARTITION_RETENTION_DAYS + 5));
    const staleDay = new Date();

    staleDay.setUTCHours(0, 0, 0, 0);
    staleDay.setUTCDate(staleDay.getUTCDate() - (PARTITION_RETENTION_DAYS + 5));

    const nextDay = new Date(staleDay);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${stale}" PARTITION OF "driver_position"
         FOR VALUES FROM ('${staleDay.toISOString()}') TO ('${nextDay.toISOString()}')`,
    );

    expect(await attachedPartitions()).toContain(stale);

    await driverPositionPartitionsJob.handler();

    const after = await attachedPartitions();

    // DROP and not DELETE — the entire reason the table is partitioned.
    expect(after).not.toContain(stale);

    // And today survives. A retention job that took the live day with it
    // would be the worst possible bug in this file.
    expect(after).toContain(nameFor(0));
  });
});

describe("where the driver IS, apart from where they have been", () => {
  async function lastPosition() {
    return prisma.driverLastPosition.findUnique({ where: { driverId: DRIVER } });
  }

  it("keeps one row per driver, however many pings arrive", async () => {
    await post("/route/positions", driverToken, { pings: pings(40) });
    await post("/route/positions", driverToken, { pings: pings(40) });

    // Eighty points of history, one dot on the map. The `DISTINCT ON` this
    // replaced scanned all eighty — and at the reference scale, 2,4 million an
    // hour — to produce exactly this.
    expect(
      await prisma.driverLastPosition.count({ where: { businessId: CARRIER } }),
    ).toBe(1);

    expect(
      await prisma.driverPosition.count({ where: { businessId: CARRIER } }),
    ).toBe(80);
  });

  it("holds the newest point of the batch", async () => {
    const batch = pings(10);

    await post("/route/positions", driverToken, { pings: batch });

    const stored = await lastPosition();

    expect(stored?.recorded_at.toISOString()).toBe(
      batch[batch.length - 1].recorded_at,
    );
  });

  it("does not move the dot backwards for a late backlog", async () => {
    // A phone comes out of a dead zone and flushes points that are all OLDER
    // than a fix which arrived by another route in the meantime. Without the
    // guard the dot jumps backwards, which on a map reads as a truck driving
    // in reverse.
    const recent = pings(1);

    await post("/route/positions", driverToken, { pings: recent });

    const afterRecent = await lastPosition();

    const backlog = pings(5, {
      at: new Date(Date.now() - 60 * 60 * 1000),
    });

    await post("/route/positions", driverToken, { pings: backlog });

    const afterBacklog = await lastPosition();

    expect(afterBacklog?.recorded_at.toISOString()).toBe(
      afterRecent?.recorded_at.toISOString(),
    );

    // And the backlog IS kept as history — it is only the dot that does not
    // move.
    expect(
      await prisma.driverPosition.count({ where: { businessId: CARRIER } }),
    ).toBe(6);
  });

  it("moves the dot forward for a newer point", async () => {
    await post("/route/positions", driverToken, {
      pings: pings(1, { at: new Date(Date.now() - 30 * 60 * 1000) }),
    });

    const before = await lastPosition();

    await post("/route/positions", driverToken, { pings: pings(1) });

    const after = await lastPosition();

    expect(
      (after?.recorded_at.getTime() ?? 0) > (before?.recorded_at.getTime() ?? 0),
    ).toBe(true);
  });

  it("is read by the tower, and reads by index", async () => {
    await post("/route/positions", driverToken, { pings: pings(20) });

    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT * FROM "driver_last_position"
         WHERE "businessId" = '${CARRIER}'
           AND "recorded_at" >= now() - interval '12 hours'`,
    );

    const text = plan.map((row) => row["QUERY PLAN"]).join(" ");

    // The assertion that makes the whole table worth having. A sequential
    // scan here would mean the map is back to costing what the trail costs.
    expect(text).not.toContain("Seq Scan");

    const response = await get("/route/control-tower", managerToken);

    expect(response.json().data.positions).toHaveLength(1);
  });
});
