import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { businessDateKey, businessDayRange } from "@/shared/time/business-day";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * GET /route/live (wave 4) over real HTTP and Postgres: who reads it (the
 * tower's gates), what one row says (stops, pending requests, last signal),
 * that a company never sees another's routes, and the cap of 500 with its
 * cursor. The plan of its one statement is in query-plans.test.ts.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const id = (suffix: string) =>
  `018fea00-0000-7000-8000-${suffix.padStart(12, "0")}`;

const CARRIER = id("a");
const OTHER = id("b");
const FLEET_ONLY = id("c");
const BULK = id("e");

const DRIVER = id("d1");
const OTHER_DRIVER = id("d2");
const BULK_DRIVER = id("d3");

const VEHICLE = id("c1");
const SHIPPER = id("f1");
const TOWER_TYPE = id("e1");

const ROUTE_RUNNING = id("b1");
const ROUTE_RELEASED = id("b2");
const ROUTE_PLANNED = id("b3");
const ROUTE_DONE = id("b4");
const ROUTE_TOMORROW = id("b5");
const ROUTE_OTHER = id("b9");

const tokens: Record<
  | "admin"
  | "reader"
  | "mechanic"
  | "driver"
  | "otherAdmin"
  | "fleetOnlyAdmin"
  | "master"
  | "bulkAdmin",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(businessId: string, deliveries = true) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${businessId.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(41333555000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${randomUUID()}@exemplo.com.br`,
    },
  });

  if (!deliveries) return;

  await prisma.businessEntitlement.create({
    data: { businessId, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(driverId: string, businessId: string, name: string) {
  await prisma.driver.create({
    data: {
      id: driverId,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${driverId.slice(-6)}`,
      cpf: `cpf-${driverId.slice(-6)}`,
      rg: `rg-${driverId.slice(-6)}`,
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

async function seedProfile(businessId: string, permissionKey: string) {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
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

async function seedUser(data: {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId?: string;
  driverId?: string;
  profileAccessId?: string;
  name?: string;
}): Promise<{ id: string; token: string }> {
  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: data.name ?? "Usuário",
      email: `${userId}@exemplo.com.br`,
      password: "nao-usado",
      role: data.role,
      businessId: data.businessId ?? null,
      driverId: data.driverId ?? null,
      profileAccessId: data.profileAccessId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  return { id: userId, token };
}

const today = () => businessDateKey(new Date(), "America/Sao_Paulo");

/**
 * Halfway between the company's midnight and now: "an hour ago" is
 * yesterday when the suite runs at 00:30 in São Paulo, and the route would
 * read as left open.
 */
function earlierToday(): Date {
  const now = Date.now();
  const midnight = businessDayRange(
    new Date(now),
    "America/Sao_Paulo",
  ).start.getTime();

  return new Date(midnight + Math.floor((now - midnight) / 2));
}

function dayOffset(days: number): Date {
  const date = new Date(`${today()}T00:00:00.000Z`);

  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function seedDelivery(
  status: "PENDING" | "IN_TRANSIT" | "DELIVERED",
  driverId: string | null = DRIVER,
) {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 4)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status,
      driverId,
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  return delivery.id;
}

const get = (url: string, token: string) =>
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

let reporterId = "";

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(FLEET_ONLY, false);
  await seedBusiness(BULK);

  await seedDriver(DRIVER, CARRIER, "Ana Motorista");
  await seedDriver(OTHER_DRIVER, OTHER, "Xavier");
  await seedDriver(BULK_DRIVER, BULK, "Bia Volume");

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
      license_plate: "LIV1E23",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: fuelType.id,
    },
  });

  const readerProfile = await seedProfile(CARRIER, "delivery_manage");
  const mechanicProfile = await seedProfile(CARRIER, "fuel_manage");

  tokens.admin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: CARRIER })
  ).token;
  tokens.reader = (
    await seedUser({
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: readerProfile,
    })
  ).token;
  tokens.mechanic = (
    await seedUser({
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: mechanicProfile,
    })
  ).token;

  const driverUser = await seedUser({
    role: "BUSINESS_USER",
    businessId: CARRIER,
    driverId: DRIVER,
    // The driver's profile reads deliveries for their own day: the tower's
    // gate refuses the token anyway.
    profileAccessId: readerProfile,
    name: "Ana Motorista",
  });

  tokens.driver = driverUser.token;
  reporterId = driverUser.id;

  tokens.otherAdmin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: OTHER })
  ).token;
  tokens.fleetOnlyAdmin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: FLEET_ONLY })
  ).token;
  tokens.master = (await seedUser({ role: "MASTER" })).token;
  tokens.bulkAdmin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: BULK })
  ).token;

  const route = (
    routeId: string,
    code: number,
    status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED",
    extra: Record<string, unknown> = {},
  ) =>
    prisma.route.create({
      data: {
        id: routeId,
        code,
        status,
        scheduled_date: dayOffset(0),
        businessId: CARRIER,
        driverId: DRIVER,
        ...extra,
      },
    });

  await route(ROUTE_RUNNING, 1, "IN_PROGRESS", {
    vehicleId: VEHICLE,
    started_at: earlierToday(),
  });
  await route(ROUTE_RELEASED, 2, "RELEASED");
  await route(ROUTE_PLANNED, 3, "PLANNED");
  await route(ROUTE_DONE, 4, "COMPLETED", {
    started_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
    completed_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  await route(ROUTE_TOMORROW, 5, "RELEASED", { scheduled_date: dayOffset(1) });

  await prisma.route.create({
    data: {
      id: ROUTE_OTHER,
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: dayOffset(0),
      started_at: new Date(Date.now() - 30 * 60 * 1000),
      businessId: OTHER,
      driverId: OTHER_DRIVER,
    },
  });

  // The running route: one delivered, one waiting for the tower, one
  // cancelled — "1 de 2" with a request pending.
  const delivered = await seedDelivery("DELIVERED");
  const waiting = await seedDelivery("IN_TRANSIT");
  const cancelled = await seedDelivery("PENDING", null);

  const stopCreatedAt = new Date(Date.now() - 50 * 60 * 1000);

  await prisma.routeStop.createMany({
    data: [
      {
        sequence: 10,
        status: "COMPLETED",
        routeId: ROUTE_RUNNING,
        deliveryId: delivered,
        created_at: stopCreatedAt,
      },
      {
        sequence: 20,
        status: "PENDING",
        routeId: ROUTE_RUNNING,
        deliveryId: waiting,
        created_at: stopCreatedAt,
      },
      {
        sequence: 30,
        status: "CANCELLED",
        routeId: ROUTE_RUNNING,
        deliveryId: cancelled,
        created_at: stopCreatedAt,
      },
    ],
  });

  await prisma.occurrenceType.create({
    data: {
      id: TOWER_TYPE,
      name: "Cliente ausente (torre)",
      blocks_delivery: true,
      requires_authorization: true,
      businessId: CARRIER,
    },
  });

  // A driver's request on the open stop, anchored to the route by its own
  // OCCURRENCE event: live, so the queue and the row both count it.
  const occurrence = await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: waiting,
      businessId: CARRIER,
      occurrenceTypeId: TOWER_TYPE,
      reportedById: reporterId,
      authorization_status: "PENDING",
      created_at: new Date(Date.now() - 5 * 60 * 1000),
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "OCCURRENCE",
      actor: "DRIVER_APP",
      businessId: CARRIER,
      deliveryId: waiting,
      routeId: ROUTE_RUNNING,
      occurrenceId: occurrence.id,
      created_at: occurrence.created_at,
    },
  });

  await prisma.driverLastPosition.create({
    data: {
      driverId: DRIVER,
      businessId: CARRIER,
      routeId: ROUTE_RUNNING,
      latitude: -23.55,
      longitude: -46.63,
      recorded_at: new Date(Date.now() - 4 * 60 * 1000),
    },
  });

  // The cap: 501 running routes in a company of their own, in one statement.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO route (
      id, code, status, scheduled_date, started_at,
      "businessId", "driverId", created_at, updated_at
    )
    SELECT gen_random_uuid()::text, n, 'IN_PROGRESS'::"RouteStatus",
           $3::date, now() - interval '1 hour', $1, $2, now(), now()
    FROM generate_series(1, 501) AS n
    `,
    BULK,
    BULK_DRIVER,
    today(),
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("who reads the live routes", () => {
  it("an administrator and a profile that reads deliveries, as on the tower", async () => {
    for (const token of [tokens.admin, tokens.reader]) {
      const answer = await get("/route/live", token);

      expect(answer.statusCode).toBe(200);
    }
  });

  it("refuses a profile without the read key", async () => {
    const answer = await get("/route/live", tokens.mechanic);

    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("refuses a driver token, whatever the profile says", async () => {
    const answer = await get("/route/live", tokens.driver);

    expect(answer.statusCode).toBe(403);
  });

  it("refuses a company without Entregas", async () => {
    const answer = await get("/route/live", tokens.fleetOnlyAdmin);

    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ code: "MODULE_NOT_ENABLED" });
  });

  it("asks a MASTER which company, and reads the one named", async () => {
    const without = await get("/route/live", tokens.master);

    expect(without.statusCode).toBe(400);
    expect(without.json()).toMatchObject({ code: "BUSINESS_NOT_IDENTIFIED" });

    const named = await get(`/route/live?businessId=${OTHER}`, tokens.master);

    expect(named.statusCode).toBe(200);
    expect(named.json().data.map((row: { id: string }) => row.id)).toEqual([
      ROUTE_OTHER,
    ]);
  });
});

describe("one company's live routes", () => {
  it("lists the running and today's released ones, running first", async () => {
    const answer = await get("/route/live", tokens.admin);
    const body = answer.json();

    expect(body.data.map((row: { id: string }) => row.id)).toEqual([
      ROUTE_RUNNING,
      ROUTE_RELEASED,
    ]);
    expect(body.meta).toMatchObject({
      day: today(),
      timeZone: "America/Sao_Paulo",
      silentAfterMs: 600_000,
      limit: 500,
      truncated: false,
      nextCursor: null,
    });
  });

  it("says, per row, the driver, the plate, the stops, the request and the signal", async () => {
    const answer = await get("/route/live", tokens.admin);
    const [running, released] = answer.json().data;

    expect(running).toMatchObject({
      id: ROUTE_RUNNING,
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: today(),
      stale: false,
      driverId: DRIVER,
      driver_name: "Ana Motorista",
      vehicle_plate: "LIV1E23",
      stops_total: 2,
      stops_resolved: 1,
      pending_authorizations: 1,
      position: { lat: -23.55, lng: -46.63 },
    });
    expect(running.last_signal_at).toBe(running.position.recorded_at);

    expect(released).toMatchObject({
      id: ROUTE_RELEASED,
      status: "RELEASED",
      started_at: null,
      vehicle_plate: null,
      stops_total: 0,
      stops_resolved: 0,
      pending_authorizations: 0,
    });

    // Lean: nothing of the tower's funnel, events or stops rides along.
    expect(Object.keys(answer.json())).toEqual(["data", "meta"]);
    expect(running).not.toHaveProperty("stops");
  });

  it("agrees with the tower's queue on what waits", async () => {
    const queue = await get(
      "/delivery/occurrence-authorizations?view=summary",
      tokens.admin,
    );

    expect(queue.json()).toMatchObject({ view: "summary", total: 1 });
  });

  it("never shows another company's routes, and refuses naming them", async () => {
    const other = await get("/route/live", tokens.otherAdmin);

    expect(other.json().data.map((row: { id: string }) => row.id)).toEqual([
      ROUTE_OTHER,
    ]);

    const peeking = await get(
      `/route/live?businessId=${CARRIER}`,
      tokens.otherAdmin,
    );

    expect(peeking.statusCode).toBe(403);
    expect(peeking.json()).toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
});

describe("the cap", () => {
  it("stops at 500, says so, and the cursor brings the rest", async () => {
    const first = await get("/route/live", tokens.bulkAdmin);
    const body = first.json();

    expect(body.data).toHaveLength(500);
    expect(body.meta).toMatchObject({ truncated: true, limit: 500 });
    expect(typeof body.meta.nextCursor).toBe("string");

    const second = await get(
      `/route/live?cursor=${encodeURIComponent(body.meta.nextCursor)}`,
      tokens.bulkAdmin,
    );
    const rest = second.json();

    expect(rest.data.map((row: { code: number }) => row.code)).toEqual([501]);
    expect(rest.meta).toMatchObject({ truncated: false, nextCursor: null });
  });

  it("refuses a forged cursor with 400 INVALID_CURSOR", async () => {
    const answer = await get(
      "/route/live?cursor=nao-e-um-cursor",
      tokens.admin,
    );

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("refuses a cursor whose code is past the integer column, instead of a 500", async () => {
    // Well-formed, but the repository binds the code as ::int and Postgres
    // answered "integer out of range".
    const forged = Buffer.from(
      JSON.stringify({ r: 0, c: 9_999_999_999 }),
    ).toString("base64url");

    const answer = await get(`/route/live?cursor=${forged}`, tokens.admin);

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: "INVALID_CURSOR" });
  });
});
