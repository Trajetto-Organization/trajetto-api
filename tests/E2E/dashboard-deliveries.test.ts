import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The overview, and the module it had never heard of.
 *
 * `/dashboard/overview` is the screen every login lands on, and it counted
 * vehicles, drivers, parts, suppliers, service orders, users and fines —
 * everything the product did before Entregas existed. The word "delivery"
 * appeared in its DTO zero times. A carrier whose whole operation is
 * deliveries opened the dashboard and was told how many spare parts it had.
 *
 * Over real HTTP rather than against the use case, and that is the point of
 * the file: the route declares a zod response schema, and Fastify STRIPS any
 * property the schema does not list. A use-case test would have passed with
 * the schema untouched and the API still answering without the new fields —
 * which is exactly what happened the first time this was wired.
 *
 * Three refusals are asserted next to the one acceptance, because the counts
 * are gated twice and the gates answer different questions: a permission is
 * what a PERSON may do, an entitlement is what the COMPANY bought.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const HIRED = "018fd200-0000-7000-8000-00000000000a";
const NOT_HIRED = "018fd200-0000-7000-8000-00000000000b";

const DISPATCHER = "018fd200-0000-7000-8000-0000000000a1";
const MECHANIC = "018fd200-0000-7000-8000-0000000000a2";
const OUTSIDER = "018fd200-0000-7000-8000-0000000000b1";

const DRIVER = "018fd200-0000-7000-8000-0000000000d1";
const SHIPPER = "018fd200-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fd200-0000-7000-8000-0000000000f2";

let dispatcherToken = "";
let mechanicToken = "";
let outsiderToken = "";

let dispatcherProfile = "";
let mechanicProfile = "";
let outsiderProfile = "";

async function tokenFor(
  userId: string,
  businessId: string | null,
): Promise<string> {
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
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function seedBusiness(id: string, label: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: label,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(70000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `painel-${randomUUID()}@exemplo.com.br`,
    },
  });
}

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
            canWrite: true,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function overviewFor(token: string): Promise<any> {
  const response = await app.inject({
    method: "GET",
    url: "/dashboard/overview",
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  return response.json();
}

beforeAll(async () => {
  await seedBusiness(HIRED, "Transportadora com Entregas");
  await seedBusiness(NOT_HIRED, "Transportadora só de Frota");

  // Only the first company hired the module.
  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: HIRED, module: "DELIVERIES", enabled: true },
      { businessId: NOT_HIRED, module: "DELIVERIES", enabled: false },
    ],
  });

  dispatcherProfile = await seedProfile(HIRED, "Despacho", "delivery_manage");
  mechanicProfile = await seedProfile(HIRED, "Oficina", "fuel_manage");
  outsiderProfile = await seedProfile(
    NOT_HIRED,
    "Despacho sem módulo",
    "delivery_manage",
  );

  await prisma.user.createMany({
    data: [
      {
        id: DISPATCHER,
        name: "Despachante",
        email: `despacho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: dispatcherProfile,
      },
      {
        id: MECHANIC,
        name: "Mecânico",
        email: `oficina-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: HIRED,
        profileAccessId: mechanicProfile,
      },
      {
        id: OUTSIDER,
        name: "Despachante sem módulo",
        email: `sem-modulo-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: NOT_HIRED,
        profileAccessId: outsiderProfile,
      },
    ],
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista do Painel",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Date.now()).slice(-11),
      rg: randomUUID().slice(0, 9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: HIRED,
    },
  });

  /**
   * Three deliveries in three different states, created THIS month so they
   * land in the current card as well as in the operation block.
   *
   * The states are chosen to make the two numbers differ: if everything were
   * PENDING, `unassigned` and the monthly count would be the same number and
   * a test could not tell which one it was reading.
   */
  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador do Painel", businessId: HIRED },
  });

  const base = {
    businessId: HIRED,
    shipperId: SHIPPER,
    recipient_name: "Cliente",
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "10",
  };

  await prisma.delivery.create({
    data: { ...base, code: "900001", status: "PENDING" },
  });

  await prisma.delivery.create({
    data: { ...base, code: "900002", status: "PENDING", driverId: DRIVER },
  });

  await prisma.delivery.create({
    data: { ...base, code: "900003", status: "IN_TRANSIT", driverId: DRIVER },
  });

  /**
   * Deliveries in the company that never hired the module.
   *
   * Without these the refusal below proves nothing: a company with no rows
   * counts zero whether or not the gate is there, and the mutation that
   * deletes the gate entirely passes the test. It is only a real assertion
   * when there is something to leak.
   */
  await prisma.shipper.create({
    data: {
      id: OTHER_SHIPPER,
      name: "Embarcador da outra",
      businessId: NOT_HIRED,
    },
  });

  await prisma.delivery.createMany({
    data: [
      {
        businessId: NOT_HIRED,
        shipperId: OTHER_SHIPPER,
        code: "910001",
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "PENDING",
      },
      {
        businessId: NOT_HIRED,
        shipperId: OTHER_SHIPPER,
        code: "910002",
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "IN_TRANSIT",
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.shipper.deleteMany({
    where: { id: { in: [SHIPPER, OTHER_SHIPPER] } },
  });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [DISPATCHER, MECHANIC, OUTSIDER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [DISPATCHER, MECHANIC, OUTSIDER] } },
  });

  await prisma.permission.deleteMany({
    where: {
      profileAccessId: {
        in: [dispatcherProfile, mechanicProfile, outsiderProfile],
      },
    },
  });
  await prisma.profileAccess.deleteMany({
    where: {
      id: { in: [dispatcherProfile, mechanicProfile, outsiderProfile] },
    },
  });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [HIRED, NOT_HIRED] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [HIRED, NOT_HIRED] } },
  });

  await prisma.$disconnect();
});

describe("a dispatcher whose company hired the module", () => {
  it("is told how many deliveries and routes the month produced", async () => {
    dispatcherToken = await tokenFor(DISPATCHER, HIRED);

    const overview = await overviewFor(dispatcherToken);

    expect(overview.counts.deliveries).toBeDefined();
    expect(overview.counts.deliveries.currentMonth).toBe(3);

    // Routes exist as a card even at zero: the company has the module, and a
    // missing card would read as "this product has no routes".
    expect(overview.counts.routes).toBeDefined();
    expect(overview.counts.routes.currentMonth).toBe(0);
  });

  it("carries deliveries through the trend, under the right key", async () => {
    const overview = await overviewFor(dispatcherToken);

    const current = overview.activityTrends.at(-1);

    // `deliverys` is what the default pluralisation produces, and the chart
    // keys off this name — a wrong one draws a line of undefined.
    expect(current).toHaveProperty("deliveries");
    expect(current.deliveries).toBe(3);
  });

  it("says what the operation is doing right now, not only its size", async () => {
    const overview = await overviewFor(dispatcherToken);

    expect(overview.deliveryOperation).not.toBeNull();

    // One PENDING with nobody on it, one PENDING with a driver, one already
    // moving. Three different numbers out of three rows is what proves these
    // are the operation's states and not the monthly count wearing a hat.
    expect(overview.deliveryOperation).toMatchObject({
      unassigned: 1,
      designated: 1,
      inRoute: 1,
    });
  });
});

describe("a colleague at the same company without delivery permission", () => {
  it("gets no delivery counts at all", async () => {
    mechanicToken = await tokenFor(MECHANIC, HIRED);

    const overview = await overviewFor(mechanicToken);

    // The company HAS three deliveries this month. This person gets zero,
    // and that is the assertion: a number that would be non-zero if the gate
    // were not there.
    expect(overview.counts.deliveries.currentMonth).toBe(0);
    expect(overview.counts.routes.currentMonth).toBe(0);

    expect(overview.deliveryOperation).toBeNull();
  });

  it("still gets the rest of the dashboard", async () => {
    const overview = await overviewFor(mechanicToken);

    expect(overview.counts.vehicles).toBeDefined();
    expect(overview.recentActivity).toBeDefined();
  });
});

describe("a dispatcher whose company never hired the module", () => {
  it("is shown nothing about deliveries, permission or not", async () => {
    outsiderToken = await tokenFor(OUTSIDER, NOT_HIRED);

    const overview = await overviewFor(outsiderToken);

    /**
     * This user holds `delivery_manage` — the permission alone is not the
     * question. A BUSINESS_ADMIN passes every permission check by definition
     * and would otherwise be shown cards for a module their company never
     * bought.
     */
    expect(overview.counts.deliveries.currentMonth).toBe(0);
    expect(overview.deliveryOperation).toBeNull();
  });

  it("does not leak the two deliveries its own database rows would count", async () => {
    // The company has rows — somebody imported before the module was switched
    // off, which is the ordinary way this happens. The gate has to hold on
    // data that exists, not only on an empty table.
    const own = await prisma.delivery.count({
      where: { businessId: NOT_HIRED },
    });

    expect(own, "o cenário perdeu as entregas que provam a regra").toBe(2);

    const overview = await overviewFor(outsiderToken);

    expect(overview.counts.deliveries.currentMonth).toBe(0);
  });
});
