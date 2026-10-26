import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

import {
  businessDateKey,
  businessDayRange,
  businessToday,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

import { pauseTypeId } from "./support/pause-type-seed";

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

/**
 * A driver of its own for the day-boundary test.
 *
 * The trail counts everything the driver recorded, and DRIVER accumulates a
 * thousand points earlier in this file — sharing it would make the count
 * depend on which tests ran first.
 */
const TRAIL_DRIVER = "018f9000-0000-7000-8000-0000000000d3";
const OTHER_DRIVER = "018f9000-0000-7000-8000-0000000000d2";

const VEHICLE = "018f9000-0000-7000-8000-0000000000c1";
const SHIPPER = "018f9000-0000-7000-8000-0000000000f1";

let managerToken: string;
let driverToken: string;

let routeId: string;

/** A company in Rio Branco (UTC-5), for the day-boundary counters. */
const COUNTER = "018f9000-0000-7000-8000-00000000000c";
const COUNTER_MANAGER = "018f9000-0000-7000-8000-0000000000a3";
const COUNTER_DRIVER = "018f9000-0000-7000-8000-0000000000d4";
const COUNTER_SHIPPER = "018f9000-0000-7000-8000-0000000000f2";
const COUNTER_ABSENT = "018f9000-0000-7000-8000-0000000000f3";

/** A company that never hired Entregas. */
const NO_MODULE = "018f9000-0000-7000-8000-00000000000d";
const NO_MODULE_ADMIN = "018f9000-0000-7000-8000-0000000000a4";

const MASTER = "018f9000-0000-7000-8000-0000000000a5";

/** BUSINESS_USERs of the carrier: one reads deliveries, one only fuel. */
const READER = "018f9000-0000-7000-8000-0000000000a6";
const MECHANIC = "018f9000-0000-7000-8000-0000000000a7";

let counterToken: string;
let noModuleToken: string;
let masterToken: string;
let readerToken: string;
let mechanicToken: string;

async function seedProfile(
  businessId: string,
  name: string,
  permissionKey: string,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: name,
            canRead: true,
            canWrite: false,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

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
function pings(
  count: number,
  options: { at?: Date; accuracy?: number; everyMs?: number } = {},
) {
  const at = options.at ?? new Date();
  const everyMs = options.everyMs ?? 15_000;

  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55 + index * 0.0001,
    longitude: -46.63 + index * 0.0001,
    accuracy: options.accuracy ?? 10,
    speed: 30,
    heading: 90,
    battery: 80,
    recorded_at: new Date(
      at.getTime() - (count - index) * everyMs,
    ).toISOString(),
  }));
}

/**
 * The widest spacing that keeps `total` pings inside TODAY, locally.
 *
 * The trail is a day's worth of a driver's movement, and the day it means is
 * the OPERATION's day — local midnight to local midnight, not UTC. The fixture
 * used to walk backwards from `now` at fifteen seconds a point, so a thousand
 * points reached four hours and ten minutes into the past. Run in the
 * afternoon that is all today; run at 02:45 it crosses midnight, and a third
 * of the pings land on yesterday. The test then reports 658 of 1000 and reads
 * as a product bug.
 *
 * It was one: a test that only passes during office hours says nothing about
 * the code at 3am, which is when a night shift's trail is drawn.
 */
function spacingWithinToday(total: number): number {
  const now = new Date();

  // The COMPANY's midnight (São Paulo, the fixture's zone), not the runner's:
  // on a UTC runner at 01:00 in São Paulo the local midnight was four hours
  // earlier, and a third of the pings landed on the company's yesterday.
  const midnight = businessDayRange(now, "America/Sao_Paulo").start;

  // A minute of head room: the oldest ping must be after midnight, not on it.
  const room = now.getTime() - midnight.getTime() - 60_000;

  // Twenty milliseconds at the least: points only need distinct instants.
  return Math.max(20, Math.min(15_000, Math.floor(room / total)));
}

/**
 * An instant between the company's midnight and now: `fraction` of the way.
 *
 * "Thirty minutes ago" is yesterday when the suite runs at 00:12 in São Paulo,
 * and a test that expects it in today's feed fails for an hour every night.
 */
function earlierToday(fraction: number): Date {
  const now = Date.now();
  const midnight = businessDayRange(
    new Date(now),
    "America/Sao_Paulo",
  ).start.getTime();

  return new Date(midnight + Math.floor((now - midnight) * fraction));
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "11222888000166");
  await seedBusiness(OTHER, "11222888000155");

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(TRAIL_DRIVER, CARRIER);
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

  await seedBusiness(COUNTER, "11222888000144");
  await prisma.business.update({
    where: { id: COUNTER },
    data: { timezone: "America/Rio_Branco" },
  });
  await seedDriver(COUNTER_DRIVER, COUNTER);
  await prisma.shipper.create({
    data: {
      id: COUNTER_SHIPPER,
      name: "Embarcador do Acre",
      businessId: COUNTER,
    },
  });
  await prisma.occurrenceType.create({
    data: {
      id: COUNTER_ABSENT,
      name: "Cliente ausente",
      blocks_delivery: true,
      businessId: COUNTER,
    },
  });

  // Seeded like the others, then the contract taken away.
  await seedBusiness(NO_MODULE, "11222888000133");
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: NO_MODULE },
  });

  const readerProfile = await seedProfile(
    CARRIER,
    "Despacho",
    "delivery_manage",
  );
  const mechanicProfile = await seedProfile(CARRIER, "Oficina", "fuel_manage");

  await prisma.user.createMany({
    data: [
      {
        id: COUNTER_MANAGER,
        name: "Gestora do Acre",
        email: `acre-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: COUNTER,
      },
      {
        id: NO_MODULE_ADMIN,
        name: "Admin sem Entregas",
        email: `sem-modulo-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: NO_MODULE,
      },
      {
        id: MASTER,
        name: "Suporte",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: READER,
        name: "Despachante",
        email: `despacho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: readerProfile,
      },
      {
        id: MECHANIC,
        name: "Mecânico",
        email: `oficina-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: mechanicProfile,
      },
    ],
  });

  counterToken = await tokenFor(COUNTER_MANAGER);
  noModuleToken = await tokenFor(NO_MODULE_ADMIN);
  masterToken = await tokenFor(MASTER);
  readerToken = await tokenFor(READER);
  mechanicToken = await tokenFor(MECHANIC);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

beforeEach(async () => {
  await prisma.driverLastPosition.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.driverPosition.deleteMany({ where: { businessId: CARRIER } });
  await prisma.routeStop.deleteMany({
    where: { route: { businessId: CARRIER } },
  });
  await prisma.route.deleteMany({ where: { businessId: CARRIER } });

  const route = await prisma.route.create({
    data: {
      code: Math.floor(Math.random() * 100000),
      name: "Rota da torre",
      status: "IN_PROGRESS",
      scheduled_date: businessToday("America/Sao_Paulo"),
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

  await prisma.user.deleteMany({
    where: { id: { in: [MANAGER, DRIVER_USER] } },
  });
  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.driver.deleteMany({
    where: { id: { in: [DRIVER, OTHER_DRIVER] } },
  });
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
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

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
    expect(positions[0]).toMatchObject({
      state: "moving",
      routeStatus: "IN_PROGRESS",
    });

    // Named, so the dispatcher can act on it without a second lookup.
    expect(positions[0].driverName).toBeTruthy();
    expect(positions[0].routeCode).toBeGreaterThan(0);
  });

  it("says when the driver of a running route is on an open pause", async () => {
    await post("/route/positions", driverToken, { pings: pings(3) });

    const startedAt = new Date(Date.now() - 5 * 60_000);

    const pause = await prisma.driverPause.create({
      data: {
        kind: "MEAL",
        started_at: startedAt,
        start_submission_id: randomUUID(),
        businessId: CARRIER,
        driverId: DRIVER,
        occurrenceTypeId: await pauseTypeId(prisma, CARRIER, "MEAL"),
      },
    });

    try {
      const paused = (await get("/route/control-tower", managerToken)).json()
        .data.positions;

      expect(paused[0]).toMatchObject({
        driverId: DRIVER,
        pausedSince: startedAt.toISOString(),
      });

      await prisma.driverPause.update({
        where: { id: pause.id },
        data: { ended_at: new Date() },
      });

      const back = (await get("/route/control-tower", managerToken)).json().data
        .positions;

      expect(back[0]).toMatchObject({ driverId: DRIVER, pausedSince: null });
    } finally {
      await prisma.driverPause.deleteMany({ where: { id: pause.id } });
    }
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
    expect(
      funnel.find((entry: { status: string }) => entry.status === "FAILED"),
    ).toMatchObject({ total: 0 });
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

    const { positions } = (
      await get("/route/control-tower", managerToken)
    ).json().data;

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
    // Two full batches: more points than the trail will draw, and all of them
    // inside the local day whatever time the suite runs at.
    const everyMs = spacingWithinToday(1000);

    await post("/route/positions", driverToken, {
      pings: pings(500, { everyMs }),
    });

    await post("/route/positions", driverToken, {
      pings: pings(500, {
        at: new Date(Date.now() - 500 * everyMs),
        everyMs,
      }),
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
    return prisma.driverLastPosition.findUnique({
      where: { driverId: DRIVER },
    });
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
      (after?.recorded_at.getTime() ?? 0) >
        (before?.recorded_at.getTime() ?? 0),
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

describe("the trail's day is the company's day", () => {
  /**
   * The window used to be the PROCESS's day, and the container runs in UTC:
   * opened after 21:00 in São Paulo, the trail started at 21:00 and the
   * working morning was gone. The old tests built their times with the
   * runner's own clock on both sides, so on a UTC runner they proved nothing.
   *
   * Now both ends are placed on the company's civil day in its own zone
   * (São Paulo, the default), whatever zone the runner is in: 08:00 and
   * 22:30 there sit on two different UTC days and one working day.
   */
  const ZONE = "America/Sao_Paulo";

  function companyWallTime(dayKey: string, hour: number, minute: number): Date {
    const [year, month, date] = dayKey.split("-").map(Number);

    return zonedWallTimeToUtc(ZONE, year, month, date, hour, minute);
  }

  /**
   * The UTC-day partitions these points land in. The job keeps yesterday (UTC)
   * onward, and a company's day reaches further back: between 00:00 and 03:00
   * UTC, São Paulo's yesterday is the day BEFORE the UTC yesterday, and this
   * fresh database has no partition for it (production does: partitions are
   * created a week ahead, so a day's partition exists before its points).
   */
  async function ensurePartitionsFor(points: Date[]): Promise<void> {
    const { partitionName } = await import(
      "@/jobs/cron/driver-position-partitions-job"
    );
    const days = new Set(
      points.map((point) => point.toISOString().slice(0, 10)),
    );

    for (const day of days) {
      const from = new Date(`${day}T00:00:00.000Z`);
      const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${partitionName(from)}" PARTITION OF "driver_position"
           FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      );
    }
  }

  async function seedBothEndsOfTheDay(dayKey: string): Promise<void> {
    const points = [
      companyWallTime(dayKey, 8, 0),
      companyWallTime(dayKey, 22, 30),
      // One minute before the day and the first instant of the next: neither.
      companyWallTime(dayKey, 0, -1),
      companyWallTime(dayKey, 24, 0),
    ];

    await ensurePartitionsFor(points);

    await prisma.driverPosition.createMany({
      data: points.map((recorded_at, index) => ({
        businessId: CARRIER,
        driverId: TRAIL_DRIVER,
        routeId,
        latitude: -23.55 + index * 0.001,
        longitude: -46.63 + index * 0.001,
        accuracy: 10,
        speed: 30,
        heading: 90,
        recorded_at,
      })),
    });
  }

  it("keeps the morning and the late evening in the same day", async () => {
    const today = businessDateKey(new Date(), ZONE);

    await seedBothEndsOfTheDay(today);

    const response = await get(
      `/route/driver-trail/${TRAIL_DRIVER}`,
      managerToken,
    );

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);

    const trail = response.json().data;

    expect(trail.day).toBe(today);
    expect(trail.recorded, "a trilha não cobre o dia da empresa").toBe(2);
  });

  it("reads an explicit day in the company's zone", async () => {
    // Yesterday, so its partitions exist: the job keeps the day before.
    const { driverPositionPartitionsJob } = await import(
      "@/jobs/cron/driver-position-partitions-job"
    );

    await driverPositionPartitionsJob.handler();

    const yesterday = businessDateKey(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      ZONE,
    );

    await seedBothEndsOfTheDay(yesterday);

    const response = await get(
      `/route/driver-trail/${TRAIL_DRIVER}?day=${yesterday}`,
      managerToken,
    );

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
    expect(response.json().data).toMatchObject({ day: yesterday, recorded: 2 });
  });

  it("reads the day in the company's own zone, not the server's", async () => {
    // Rio Branco (UTC-5): its day is [05:00Z, 05:00Z of the next day). A
    // window in the server's zone — UTC in the container, São Paulo on a
    // laptop — loses the late evening, whichever of the two runs this.
    const { driverPositionPartitionsJob } = await import(
      "@/jobs/cron/driver-position-partitions-job"
    );

    await driverPositionPartitionsJob.handler();

    const RIO_BRANCO = "America/Rio_Branco";
    const today = businessDateKey(new Date(), RIO_BRANCO);
    const [year, month, date] = today.split("-").map(Number);

    const at = (hour: number, minute: number) =>
      zonedWallTimeToUtc(RIO_BRANCO, year, month, date, hour, minute);

    // Between 00:00 and 05:00 UTC, Rio Branco's day starts before the UTC
    // yesterday the job keeps.
    await ensurePartitionsFor([at(0, 30), at(23, 30), at(0, -1), at(24, 0)]);

    await prisma.driverPosition.createMany({
      data: [at(0, 30), at(23, 30), at(0, -1), at(24, 0)].map(
        (recorded_at, index) => ({
          businessId: COUNTER,
          driverId: COUNTER_DRIVER,
          latitude: -9.97 + index * 0.001,
          longitude: -67.81,
          accuracy: 10,
          recorded_at,
        }),
      ),
    });

    const response = await get(
      `/route/driver-trail/${COUNTER_DRIVER}`,
      counterToken,
    );

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
    expect(response.json().data).toMatchObject({ day: today, recorded: 2 });

    // The two ends of the company's day — not one minute of the day before
    // standing in for the late evening, which a São Paulo window returns.
    expect(
      response
        .json()
        .data.points.map((point: { recordedAt: string }) => point.recordedAt),
    ).toEqual([at(0, 30).toISOString(), at(23, 30).toISOString()]);
  });

  it("refuses a day that does not exist", async () => {
    const response = await get(
      `/route/driver-trail/${TRAIL_DRIVER}?day=2026-02-30`,
      managerToken,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_DAY");
  });
});

describe("the tower's numbers are the company's day (TWR-1/TWR-2, DLV-MON-1/2)", () => {
  /**
   * Real deliveries on both sides of the company's midnight, in Rio Branco
   * (UTC-5): its day starts at 05:00 UTC. The old code counted deliveries
   * CREATED since the process's midnight — UTC in the container, São Paulo on
   * a laptop — so every one of these lands on the wrong side somewhere, at
   * any hour the suite runs.
   */
  const ZONE = "America/Rio_Branco";

  let range: { start: Date; end: Date };

  const minutes = (base: Date, delta: number) =>
    new Date(base.getTime() + delta * 60_000);

  beforeAll(async () => {
    range = businessDayRange(new Date(), ZONE);

    const today = businessToday(ZONE);

    const counterRoute = await prisma.route.create({
      data: {
        code: 900001,
        status: "RELEASED",
        scheduled_date: today,
        businessId: COUNTER,
        driverId: COUNTER_DRIVER,
      },
    });

    const tomorrowRoute = await prisma.route.create({
      data: {
        code: 900002,
        status: "PLANNED",
        scheduled_date: new Date(today.getTime() + 24 * 60 * 60 * 1000),
        businessId: COUNTER,
        driverId: COUNTER_DRIVER,
      },
    });

    const make = (
      key: string,
      data: Partial<{
        status: "PENDING" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "CANCELLED";
        delivered_at: Date;
        created_at: Date;
        driverId: string;
      }>,
    ) =>
      prisma.delivery.create({
        data: {
          recipient_name: `Cliente ${key}`,
          city: "Rio Branco",
          uf: "AC",
          street: "Rua",
          shipperId: COUNTER_SHIPPER,
          businessId: COUNTER,
          ...data,
        },
      });

    // Created last week, delivered one minute after the company's midnight.
    await make("depois", {
      status: "DELIVERED",
      driverId: COUNTER_DRIVER,
      delivered_at: minutes(range.start, 1),
      created_at: minutes(range.start, -7 * 24 * 60),
    });

    // Delivered one minute before it: yesterday.
    await make("antes", {
      status: "DELIVERED",
      delivered_at: minutes(range.start, -1),
    });

    // Imported yesterday, out with a driver now.
    await make("na-rua", {
      status: "IN_TRANSIT",
      created_at: minutes(range.start, -600),
      driverId: COUNTER_DRIVER,
    });

    // On today's route, and on tomorrow's.
    const loaded = await make("carregada", {
      status: "PENDING",
      driverId: COUNTER_DRIVER,
    });
    const later = await make("amanha", {
      status: "PENDING",
      driverId: COUNTER_DRIVER,
    });

    await prisma.routeStop.createMany({
      data: [
        { routeId: counterRoute.id, deliveryId: loaded.id, sequence: 1 },
        { routeId: tomorrowRoute.id, deliveryId: later.id, sequence: 1 },
      ],
    });

    // The backlog: created today, on no route. Not today's work.
    await make("sem-rota", { status: "PENDING" });

    // Failed yesterday, then edited today (DLV-MON-2).
    const edited = await make("editada", { status: "FAILED" });

    await prisma.deliveryEvent.create({
      data: {
        type: "STATUS_CHANGE",
        actor: "USER",
        status_from: "IN_TRANSIT",
        status_to: "FAILED",
        deliveryId: edited.id,
        businessId: COUNTER,
        created_at: minutes(range.start, -120),
      },
    });

    await prisma.$executeRaw`UPDATE "delivery" SET "updated_at" = ${minutes(range.start, 30)} WHERE "id" = ${edited.id}`;

    // Failed on the street today, by a blocking occurrence.
    const refused = await make("recusada", { status: "FAILED" });

    await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: refused.id,
        businessId: COUNTER,
        occurrenceTypeId: COUNTER_ABSENT,
        reportedById: COUNTER_MANAGER,
        occurred_at: minutes(range.start, 20),
        created_at: minutes(range.start, 21),
      },
    });

    await prisma.$executeRaw`UPDATE "delivery" SET "updated_at" = ${minutes(range.start, 21)} WHERE "id" = ${refused.id}`;
  });

  it("counts the documents active in the company's day", async () => {
    const response = await get("/route/control-tower", counterToken);

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const { funnel, progress, day, timeZone } = response.json().data;

    expect(timeZone).toBe(ZONE);
    expect(day).toBe(businessDateKey(new Date(), ZONE));

    const totals = Object.fromEntries(
      funnel.map((entry: { status: string; total: number }) => [
        entry.status,
        entry.total,
      ]),
    );

    expect(totals).toEqual({
      PENDING: 1, // carregada, on today's route
      IN_TRANSIT: 1, // na-rua, created yesterday
      DELIVERED: 1, // depois, not antes
      FAILED: 1, // recusada, not editada
      CANCELLED: 0,
    });

    expect(progress).toEqual({ finished: 2, total: 4, rate: 50 });
  });

  it("splits the same documents by driver on the monitoring board (DLV-MON-3)", async () => {
    const response = await get("/route/monitoring/drivers", counterToken);

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const { drivers, day, timeZone } = response.json().data;

    expect(timeZone).toBe(ZONE);
    expect(day).toBe(businessDateKey(new Date(), ZONE));

    // carregada, not amanha: tomorrow's route is not today's load (the
    // operation summary counted both as designadas).
    expect(drivers).toEqual([
      expect.objectContaining({
        driverId: COUNTER_DRIVER,
        designated: 1,
        inRoute: 1,
        deliveredToday: 1,
        failedToday: 0,
      }),
    ]);
  });

  it("agrees with the monitoring board's routes", async () => {
    const response = await get("/route/monitoring", counterToken);

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const { routes, meta } = response.json().data;

    // Today's route, not tomorrow's.
    expect(routes.map((entry: { code: number }) => entry.code)).toEqual([
      900001,
    ]);
    expect(meta.total).toBe(1);
    expect(routes[0].stops).toHaveLength(1);
  });
});

describe("punctuality is judged at the current hour, on today's routes (TWR-3/TWR-4)", () => {
  it("waits for a departure planned for later and counts a missed one as late", async () => {
    const today = businessToday("America/Sao_Paulo");
    const now = Date.now();

    await prisma.route.createMany({
      data: [
        {
          // Its hour passed an hour ago and it is still in the yard.
          code: 800001,
          status: "RELEASED",
          scheduled_date: today,
          planned_departure_at: new Date(now - 60 * 60 * 1000),
          businessId: CARRIER,
          driverId: TRAIL_DRIVER,
        },
        {
          // Planned for two hours from now.
          code: 800002,
          status: "RELEASED",
          scheduled_date: today,
          planned_departure_at: new Date(now + 2 * 60 * 60 * 1000),
          businessId: CARRIER,
          driverId: TRAIL_DRIVER,
        },
        {
          // Next week: not today's plan at all.
          code: 800003,
          status: "RELEASED",
          scheduled_date: new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000),
          planned_departure_at: new Date(now + 7 * 24 * 60 * 60 * 1000),
          businessId: CARRIER,
          driverId: TRAIL_DRIVER,
        },
      ],
    });

    const { punctuality } = (
      await get("/route/control-tower", managerToken)
    ).json().data;

    // The fixture's route left on time; the missed one weighs as late.
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

describe("a running route whose phone went quiet long ago (TWR-9)", () => {
  it("keeps its last signal, not 'sem posição desde a saída'", async () => {
    // Fourteen hours ago: outside the map's twelve-hour window.
    const quietSince = new Date(Date.now() - 14 * 60 * 60 * 1000);

    await prisma.driverLastPosition.create({
      data: {
        driverId: DRIVER,
        businessId: CARRIER,
        routeId,
        latitude: -23.55,
        longitude: -46.63,
        recorded_at: quietSince,
      },
    });

    const { positions, activeRoutes } = (
      await get("/route/control-tower", managerToken)
    ).json().data;

    expect(
      positions.find(
        (position: { driverId: string }) => position.driverId === DRIVER,
      ),
    ).toBeUndefined();

    expect(
      activeRoutes.find(
        (route: { routeId: string }) => route.routeId === routeId,
      )?.lastSignalAt,
    ).toBe(quietSince.toISOString());
  });
});

describe("the feed says what happened today (TWR-6/TWR-7)", () => {
  it("lists a blocking occurrence, a route start and a cancellation", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente recusou",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "FAILED",
        shipperId: SHIPPER,
        businessId: CARRIER,
        driverId: DRIVER,
      },
    });

    const absent = await prisma.occurrenceType.create({
      data: {
        name: `Ausente ${randomUUID().slice(0, 6)}`,
        blocks_delivery: true,
        businessId: CARRIER,
      },
    });

    await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: delivery.id,
        businessId: CARRIER,
        occurrenceTypeId: absent.id,
        reportedById: DRIVER_USER,
        occurred_at: earlierToday(0.9),
      },
    });

    // Placed inside the company's day whatever the hour: "55 minutes ago"
    // was yesterday between 00:00 and 00:55 in São Paulo.
    await prisma.route.update({
      where: { id: routeId },
      data: { started_at: earlierToday(0.5) },
    });

    const cancelled = await prisma.route.create({
      data: {
        code: 700001,
        status: "CANCELLED",
        scheduled_date: businessToday("America/Sao_Paulo"),
        started_at: earlierToday(0.25),
        businessId: CARRIER,
        driverId: TRAIL_DRIVER,
      },
    });

    // Yesterday's proof: history, not today's news.
    await prisma.deliveryEvent.create({
      data: {
        type: "PROOF",
        actor: "DRIVER_APP",
        deliveryId: delivery.id,
        businessId: CARRIER,
        created_at: new Date(Date.now() - 36 * 60 * 60 * 1000),
      },
    });

    const { events } = (await get("/route/control-tower", managerToken)).json()
      .data;

    const occurrence = events.find(
      (event: { type: string; deliveryId: string | null }) =>
        event.type === "OCCURRENCE" && event.deliveryId === delivery.id,
    );

    expect(occurrence).toMatchObject({
      source: "occurrence",
      detail: absent.name,
      failure: true,
      recipientName: "Cliente recusou",
    });

    const types = events.map(
      (event: { type: string; routeId: string | null }) =>
        `${event.type}:${event.routeId}`,
    );

    expect(types).toContain(`ROUTE_STARTED:${routeId}`);
    expect(types).toContain(`ROUTE_CANCELLED:${cancelled.id}`);
    expect(types).toContain(`ROUTE_STARTED:${cancelled.id}`);

    expect(
      events.some((event: { type: string }) => event.type === "PROOF"),
    ).toBe(false);
  });
});

describe("who may read the operation", () => {
  it("lets a MASTER read the company picked in the selector", async () => {
    const response = await get(
      `/route/control-tower?businessId=${COUNTER}`,
      masterToken,
    );

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    expect(response.json().data.timeZone).toBe("America/Rio_Branco");

    for (const url of [
      `/route/monitoring?businessId=${COUNTER}`,
      `/route/monitoring/drivers?businessId=${COUNTER}`,
    ]) {
      const board = await get(url, masterToken);

      expect(board.statusCode, url).toBe(200);
      expect(board.json().data.timeZone, url).toBe("America/Rio_Branco");
    }
  });

  it("asks a MASTER which company", async () => {
    for (const url of [
      "/route/control-tower",
      "/route/monitoring",
      "/route/monitoring/drivers",
      `/route/driver-trail/${DRIVER}`,
    ]) {
      const response = await get(url, masterToken);

      expect(response.statusCode, url).toBe(400);
      expect(response.json().code, url).toBe("BUSINESS_NOT_IDENTIFIED");
    }
  });

  it("refuses a company without the Entregas module", async () => {
    for (const url of ["/route/control-tower", "/route/monitoring/drivers"]) {
      const response = await get(url, noModuleToken);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("MODULE_NOT_ENABLED");
    }
  });

  it("refuses the MASTER too on a company without the module (decision 4.3)", async () => {
    for (const url of [
      `/route/control-tower?businessId=${NO_MODULE}`,
      `/route/monitoring/drivers?businessId=${NO_MODULE}`,
    ]) {
      const response = await get(url, masterToken);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("MODULE_NOT_ENABLED");
    }
  });

  it("lets a BUSINESS_USER with delivery_manage read it", async () => {
    const tower = await get("/route/control-tower", readerToken);
    const board = await get("/route/monitoring", readerToken);
    const drivers = await get("/route/monitoring/drivers", readerToken);

    expect(tower.statusCode, tower.body.slice(0, 300)).toBe(200);
    expect(board.statusCode, board.body.slice(0, 300)).toBe(200);
    expect(drivers.statusCode, drivers.body.slice(0, 300)).toBe(200);
  });

  it("refuses a BUSINESS_USER without delivery_manage", async () => {
    for (const url of [
      "/route/control-tower",
      "/route/monitoring",
      "/route/monitoring/drivers",
      `/route/driver-trail/${DRIVER}`,
    ]) {
      const response = await get(url, mechanicToken);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("PERMISSION_DENIED");
    }
  });

  it("refuses another company's id to a company user", async () => {
    for (const url of [
      `/route/control-tower?businessId=${OTHER}`,
      `/route/monitoring?businessId=${OTHER}`,
      `/route/monitoring/drivers?businessId=${OTHER}`,
      `/route/driver-trail/${OTHER_DRIVER}?businessId=${OTHER}`,
      `/route/driver-trail/${DRIVER}?businessId=${OTHER}`,
    ]) {
      const response = await get(url, managerToken);

      expect(response.statusCode, url).toBe(403);
    }
  });

  it("refuses a driver token on the monitoring boards", async () => {
    for (const url of ["/route/monitoring", "/route/monitoring/drivers"]) {
      const response = await get(url, driverToken);

      expect(response.statusCode, url).toBe(403);
      expect(response.json().code, url).toBe("DRIVER_CANNOT_VIEW_PANELS");
    }
  });

  it("refuses a malformed day and an oversized page", async () => {
    expect(
      (await get("/route/monitoring?day=17-09-2026", managerToken)).statusCode,
    ).toBe(400);
    expect(
      (await get("/route/monitoring?pageSize=500", managerToken)).statusCode,
    ).toBe(400);
    expect(
      (await get("/route/monitoring/drivers?day=17-09-2026", managerToken))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await get("/route/monitoring/drivers?day=2026-02-30", managerToken)
      ).json().code,
    ).toBe("INVALID_DAY");
  });
});
