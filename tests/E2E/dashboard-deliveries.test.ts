import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import {
  businessDateKey,
  businessDayRange,
  dateOnlyFromKey,
} from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The overview, the "Operação de hoje" block and the monitoring summary,
 * over real HTTP.
 *
 * Over HTTP rather than against the use case because the route declares a
 * zod response schema: Fastify strips what it does not list and answers 500
 * for a body it cannot serialize. A use-case test passed while the API
 * answered without the new fields, once already.
 *
 * Every role that can reach the screen is here (DLVP-OPS-4): the dispatcher,
 * a read-only dispatcher, the company admin, a colleague without the
 * permission, a driver, a MASTER, and a dispatcher whose company never hired
 * the module — with rows in that company, so a missing gate would leak.
 *
 * "Today" is the company's day: the carrier is in Rio Branco (UTC-5), which
 * is neither the container's zone nor São Paulo's. A delivery finished one
 * minute before its midnight is yesterday for the company and today for
 * either of the other two calendars (DLVP-OPS-1).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RIO_BRANCO = "America/Rio_Branco";

const HIRED = "018fd200-0000-7000-8000-00000000000a";
const NOT_HIRED = "018fd200-0000-7000-8000-00000000000b";

const DISPATCHER = "018fd200-0000-7000-8000-0000000000a1";
const MECHANIC = "018fd200-0000-7000-8000-0000000000a2";
const READER = "018fd200-0000-7000-8000-0000000000a3";
const ADMIN = "018fd200-0000-7000-8000-0000000000a4";
const DRIVER_USER = "018fd200-0000-7000-8000-0000000000a5";
const WRITE_ONLY = "018fd200-0000-7000-8000-0000000000a6";
const OUTSIDER = "018fd200-0000-7000-8000-0000000000b1";
const MASTER = "018fd200-0000-7000-8000-0000000000c1";

const DRIVER = "018fd200-0000-7000-8000-0000000000d1";
const SHIPPER = "018fd200-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fd200-0000-7000-8000-0000000000f2";
const OCCURRENCE_TYPE = "018fd200-0000-7000-8000-0000000000e1";

const USERS = [
  DISPATCHER,
  MECHANIC,
  READER,
  ADMIN,
  DRIVER_USER,
  WRITE_ONLY,
  OUTSIDER,
  MASTER,
];

const profiles: string[] = [];
const tokens = new Map<string, string>();

async function tokenFor(userId: string): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;

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

  // The role and the company come from the user row; the claims only have
  // to name the session.
  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  tokens.set(userId, token);

  return token;
}

async function seedBusiness(
  id: string,
  label: string,
  timezone?: string,
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: label,
      cep: "69900000",
      city: "Rio Branco",
      uf: "AC",
      street: "Rua",
      address_number: "1",
      cnpj: String(70000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "68999999999",
      email: `painel-${randomUUID()}@exemplo.com.br`,
      ...(timezone && { timezone }),
    },
  });
}

async function seedProfile(
  businessId: string,
  name: string,
  permissionKey: string,
  canWrite = true,
  canRead = true,
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
            canRead,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  profiles.push(profile.id);

  return profile.id;
}

async function get(userId: string, url: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${await tokenFor(userId)}` },
  });
}

/**
 * A refusal with the code of its reason (decision 4.1): the status alone
 * would pass if a module refusal answered a tenant one, or the reverse.
 */
function expectRefused(
  response: Awaited<ReturnType<typeof get>>,
  code: string,
): void {
  expect(response.statusCode, response.body.slice(0, 300)).toBe(403);
  expect(response.json().code).toBe(code);
  expect(response.body).not.toContain("totals");
}

async function overviewFor(userId: string): Promise<any> {
  const response = await get(userId, "/dashboard/overview");

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  return response.json();
}

beforeAll(async () => {
  await seedBusiness(HIRED, "Transportadora com Entregas", RIO_BRANCO);
  await seedBusiness(NOT_HIRED, "Transportadora só de Frota");

  // Only the first company hired Entregas; neither hired Frotas.
  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: HIRED, module: "DELIVERIES", enabled: true },
      { businessId: NOT_HIRED, module: "DELIVERIES", enabled: false },
    ],
  });

  const dispatcherProfile = await seedProfile(
    HIRED,
    "Despacho",
    "delivery_manage",
  );
  const readerProfile = await seedProfile(
    HIRED,
    "Consulta",
    "delivery_manage",
    false,
  );
  const mechanicProfile = await seedProfile(HIRED, "Oficina", "fuel_manage");

  // Write without read: bulk-configure still stores such rows, and legacy
  // ones exist. verifyPermission reads it as no access at all (ROUTE-KEY-1).
  const writeOnlyProfile = await seedProfile(
    HIRED,
    "Só escrita",
    "delivery_manage",
    true,
    false,
  );
  const outsiderProfile = await seedProfile(
    NOT_HIRED,
    "Despacho sem módulo",
    "delivery_manage",
  );

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista do Painel",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Date.now()).slice(-11),
      rg: randomUUID().slice(0, 9),
      cep: "69900000",
      city: "Rio Branco",
      uf: "AC",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: HIRED,
    },
  });

  const user = (
    id: string,
    name: string,
    extra: Omit<
      Prisma.UserCreateManyInput,
      "id" | "name" | "email" | "password"
    >,
  ): Prisma.UserCreateManyInput => ({
    id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}@exemplo.com.br`,
    password: "nao-usado",
    ...extra,
  });

  await prisma.user.createMany({
    data: [
      user(DISPATCHER, "Despachante", {
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: dispatcherProfile,
      }),
      user(READER, "Consulta", {
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: readerProfile,
      }),
      user(MECHANIC, "Mecanico", {
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: mechanicProfile,
      }),
      user(ADMIN, "Administradora", {
        role: "BUSINESS_ADMIN",
        businessId: HIRED,
      }),
      user(WRITE_ONLY, "So escrita", {
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: writeOnlyProfile,
      }),
      user(DRIVER_USER, "Motorista", {
        role: "BUSINESS_USER",
        businessId: HIRED,
        driverId: DRIVER,
      }),
      user(OUTSIDER, "Sem modulo", {
        role: "BUSINESS_USER",
        businessId: NOT_HIRED,
        profileAccessId: outsiderProfile,
      }),
      user(MASTER, "Master", { role: "MASTER", businessId: null }),
    ],
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador do Painel", businessId: HIRED },
  });

  const base = {
    businessId: HIRED,
    shipperId: SHIPPER,
    recipient_name: "Cliente",
    cep: "69900000",
    city: "Rio Branco",
    uf: "AC",
    street: "Rua",
    address_number: "10",
  };

  // The company's day, from the real clock: the API reads the same one.
  const { start } = businessDayRange(new Date(), RIO_BRANCO);
  const minute = 60 * 1000;

  /**
   * One row per number, and different numbers per state, so a tile reading
   * the wrong bucket shows. The two DELIVERED ones straddle the company's
   * midnight: one minute after it (today) and one minute before (yesterday
   * for Rio Branco, today for UTC and for São Paulo).
   */
  await prisma.delivery.createMany({
    data: [
      { ...base, code: "900001", status: "PENDING" },
      { ...base, code: "900002", status: "PENDING", driverId: DRIVER },
      { ...base, code: "900003", status: "IN_TRANSIT", driverId: DRIVER },
      {
        ...base,
        code: "900004",
        status: "DELIVERED",
        driverId: DRIVER,
        delivered_at: new Date(start.getTime() + minute),
      },
      {
        ...base,
        code: "900005",
        status: "DELIVERED",
        driverId: DRIVER,
        delivered_at: new Date(start.getTime() - minute),
      },
    ],
  });

  // 900002 is the day's load: on a route of the company's today (decision
  // 7.1 — a PENDING with a driver and no route of the day is not designated).
  const designated = await prisma.delivery.findFirstOrThrow({
    where: { businessId: HIRED, code: "900002" },
  });

  const route = await prisma.route.create({
    data: {
      code: 1,
      businessId: HIRED,
      driverId: DRIVER,
      status: "RELEASED",
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), RIO_BRANCO)),
    },
  });

  await prisma.routeStop.create({
    data: { routeId: route.id, deliveryId: designated.id, sequence: 10 },
  });

  // One report by the driver today, one note from the panel: only the
  // driver's counts as "Relatadas pelo motorista".
  await prisma.occurrenceType.create({
    data: { id: OCCURRENCE_TYPE, name: "Cliente ausente", businessId: HIRED },
  });

  const moving = await prisma.delivery.findFirstOrThrow({
    where: { businessId: HIRED, code: "900003" },
  });

  await prisma.deliveryOccurrence.createMany({
    data: [DRIVER_USER, DISPATCHER].map((reportedById) => ({
      deliveryId: moving.id,
      businessId: HIRED,
      occurrenceTypeId: OCCURRENCE_TYPE,
      reportedById,
    })),
  });

  /**
   * Deliveries in the company that never hired the module. Without them the
   * refusal proves nothing: a company with no rows counts zero whether or
   * not the gate is there.
   */
  await prisma.shipper.create({
    data: {
      id: OTHER_SHIPPER,
      name: "Embarcador da outra",
      businessId: NOT_HIRED,
    },
  });

  await prisma.delivery.createMany({
    data: ["PENDING", "IN_TRANSIT"].map((status, index) => ({
      businessId: NOT_HIRED,
      shipperId: OTHER_SHIPPER,
      code: `91000${index}`,
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: status as "PENDING" | "IN_TRANSIT",
    })),
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await prisma.deliveryOccurrence.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.delivery.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.route.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.occurrenceType.deleteMany({ where: { id: OCCURRENCE_TYPE } });
  await prisma.shipper.deleteMany({
    where: { id: { in: [SHIPPER, OTHER_SHIPPER] } },
  });

  await prisma.refreshToken.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });

  await prisma.permission.deleteMany({
    where: { profileAccessId: { in: profiles } },
  });
  await prisma.profileAccess.deleteMany({ where: { id: { in: profiles } } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [HIRED, NOT_HIRED] } },
  });

  await prisma.$disconnect();
});

const TODAY = {
  unassigned: 1,
  // 900002, on today's route.
  designated: 1,
  inRoute: 1,
  // 900004 only: 900005 was finished before the company's midnight.
  deliveredToday: 1,
  failedToday: 0,
  // The driver's report; the panel note is not a driver report.
  occurrencesToday: 1,
};

describe("a dispatcher whose company hired the module", () => {
  it("is told how many deliveries and routes the month produced", async () => {
    const overview = await overviewFor(DISPATCHER);

    expect(overview.counts.deliveries.currentMonth).toBe(5);
    expect(overview.counts.routes.currentMonth).toBe(1);
  });

  it("carries deliveries through the trend, and no series it may not see", async () => {
    const overview = await overviewFor(DISPATCHER);

    const current = overview.activityTrends.at(-1);

    expect(overview.activityTrends).toHaveLength(6);
    expect(current.deliveries).toBe(5);
    expect(current).not.toHaveProperty("vehicles");
    expect(current).not.toHaveProperty("parts");
  });

  it("counts the operation in the company's day", async () => {
    const overview = await overviewFor(DISPATCHER);

    expect(overview.deliveryOperation).toEqual(TODAY);
  });

  it("reads the same numbers on the monitoring summary", async () => {
    const response = await get(DISPATCHER, "/delivery/operation-summary");

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    expect(response.json().data.totals).toEqual(TODAY);
  });
});

describe("the other profiles of the same company", () => {
  it("a read-only dispatcher sees the operation too", async () => {
    const overview = await overviewFor(READER);

    expect(overview.deliveryOperation).toEqual(TODAY);

    const response = await get(READER, "/delivery/operation-summary");
    expect(response.statusCode).toBe(200);
  });

  it("the admin sees it, and no Frotas series or costs the company did not hire", async () => {
    const overview = await overviewFor(ADMIN);

    expect(overview.deliveryOperation).toEqual(TODAY);

    for (const point of overview.activityTrends) {
      for (const key of [
        "parts",
        "suppliers",
        "serviceOrders",
        "fines",
        "businesses",
      ]) {
        expect(point, key).not.toHaveProperty(key);
      }

      expect(typeof point.vehicles).toBe("number");
      expect(typeof point.deliveries).toBe("number");
    }

    expect(overview.maintenanceCosts).toEqual([]);
  });

  it("a colleague without the permission gets no delivery numbers", async () => {
    const overview = await overviewFor(MECHANIC);

    // The company HAS five deliveries this month.
    expect(overview.counts.deliveries.currentMonth).toBe(0);
    expect(overview.deliveryOperation).toBeNull();

    for (const point of overview.activityTrends) {
      expect(point).not.toHaveProperty("deliveries");
      expect(point).not.toHaveProperty("routes");
    }

    const response = await get(MECHANIC, "/delivery/operation-summary");
    expectRefused(response, "PERMISSION_DENIED");
  });

  it("a write-only row is no access: nothing the summary's 403 would refuse", async () => {
    const overview = await overviewFor(WRITE_ONLY);

    // The company HAS five deliveries and a route this month.
    expect(overview.counts.deliveries.currentMonth).toBe(0);
    expect(overview.counts.routes.currentMonth).toBe(0);
    expect(overview.deliveryOperation).toBeNull();

    for (const point of overview.activityTrends) {
      expect(point).not.toHaveProperty("deliveries");
      expect(point).not.toHaveProperty("routes");
    }

    const response = await get(WRITE_ONLY, "/delivery/operation-summary");
    expectRefused(response, "PERMISSION_DENIED");
  });

  it("a driver is never shown the whole operation", async () => {
    const overview = await overviewFor(DRIVER_USER);

    expect(overview.deliveryOperation).toBeNull();

    const response = await get(DRIVER_USER, "/delivery/operation-summary");
    expectRefused(response, "DRIVER_CANNOT_VIEW_PANELS");
  });
});

describe("outside the company", () => {
  it("a MASTER has no single company to summarise on the overview", async () => {
    const overview = await overviewFor(MASTER);

    expect(overview.deliveryOperation).toBeNull();
  });

  it("a MASTER reads the company they pick, in that company's day", async () => {
    const response = await get(
      MASTER,
      `/delivery/operation-summary?businessId=${HIRED}`,
    );

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    expect(response.json().data.totals).toEqual(TODAY);
  });

  it("a dispatcher of another company is refused", async () => {
    const response = await get(
      OUTSIDER,
      `/delivery/operation-summary?businessId=${HIRED}`,
    );

    expectRefused(response, "TENANT_ACCESS_DENIED");
  });

  it("a dispatcher cannot name another company either", async () => {
    const response = await get(
      DISPATCHER,
      `/delivery/operation-summary?businessId=${NOT_HIRED}`,
    );

    expectRefused(response, "TENANT_ACCESS_DENIED");
  });
});

describe("a dispatcher whose company never hired the module", () => {
  it("is shown nothing about deliveries, permission or not", async () => {
    const overview = await overviewFor(OUTSIDER);

    expect(overview.counts.deliveries.currentMonth).toBe(0);
    expect(overview.deliveryOperation).toBeNull();

    for (const point of overview.activityTrends) {
      expect(point).not.toHaveProperty("deliveries");
    }

    const response = await get(OUTSIDER, "/delivery/operation-summary");
    expectRefused(response, "MODULE_NOT_ENABLED");
  });

  it("does not leak the two deliveries its own database rows would count", async () => {
    const own = await prisma.delivery.count({
      where: { businessId: NOT_HIRED },
    });

    expect(own, "o cenário perdeu as entregas que provam a regra").toBe(2);

    const overview = await overviewFor(OUTSIDER);

    expect(overview.counts.deliveries.currentMonth).toBe(0);
  });
});
