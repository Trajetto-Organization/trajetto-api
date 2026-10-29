import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { generateApiKey } from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What a `route.*` webhook tells an ERP about the route, over HTTP against
 * the real database.
 *
 * The payload carried the route's id, number, driver and execution times,
 * but not the day it runs, where it goes or the planned window (decision
 * 6.5). An ERP that plans its own dock from these events had to call back
 * for them. The day is a civil date (decision 1.3): "2026-09-17", never an
 * instant an integrator's parser would shift into its own zone. The public
 * read of a route answers the same facts.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe2a0-0000-7000-8000-00000000000a";
const ADMIN = "018fe2a0-0000-7000-8000-0000000000a1";
const DRIVER = "018fe2a0-0000-7000-8000-0000000000d1";

let token = "";
let routesKey = "";

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
    {
      subject: userId,
      expiresIn: "1h",
    },
  );
}

async function seedRoute(
  code: number,
  extra: {
    destination?: string | null;
    planned_departure_at?: Date | null;
    planned_arrival_at?: Date | null;
  },
): Promise<string> {
  const route = await prisma.route.create({
    data: {
      code,
      name: `Rota ${code}`,
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date("2026-09-17T00:00:00.000Z"),
      ...extra,
    },
  });

  return route.id;
}

async function cancelAndReadPayload(
  routeId: string,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "PATCH",
    url: `/route/cancel-route/${routeId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: "Cliente remarcou a coleta" },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  const row = await prisma.webhookDelivery.findFirstOrThrow({
    where: {
      businessId: CARRIER,
      topic: "route.cancelled",
      payload: { path: ["data", "route_id"], equals: routeId },
    },
    select: { payload: true },
  });

  return (row.payload as { data: Record<string, unknown> }).data;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Rotas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `rotas-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Rota",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${randomUUID().slice(0, 8)}`,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Despachante",
      email: `despacho-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  token = await tokenFor(ADMIN);

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP do cliente",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["routes:read"],
      businessId: CARRIER,
    },
  });

  routesKey = key.token;

  // The ERP subscribed to every route event through the family wildcard.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP do cliente",
      url: "https://erp.exemplo.com.br/trajetto/webhook",
      secret: "segredo-do-teste",
      businessId: CARRIER,
      topics: ["route.*"],
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { businessId: CARRIER } });
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.apiKeyUsageDaily.deleteMany({ where: { businessId: CARRIER } });
  await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });
  await prisma.route.deleteMany({ where: { businessId: CARRIER } });

  await prisma.refreshToken.deleteMany({ where: { userId: ADMIN } });
  await prisma.user.deleteMany({ where: { id: ADMIN } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("a route.* webhook", () => {
  it("carries the route's civil day, destination and planned window", async () => {
    const routeId = await seedRoute(1, {
      destination: "CD Cajamar",
      planned_departure_at: new Date("2026-09-17T09:30:00.000Z"),
      planned_arrival_at: new Date("2026-09-17T21:00:00.000Z"),
    });

    const data = await cancelAndReadPayload(routeId);

    expect(data).toMatchObject({
      route_id: routeId,
      code: 1,
      status: "CANCELLED",
      scheduled_date: "2026-09-17",
      destination: "CD Cajamar",
      planned_departure_at: "2026-09-17T09:30:00.000Z",
      planned_arrival_at: "2026-09-17T21:00:00.000Z",
      driver_id: DRIVER,
    });
  });

  it("keeps every key when the route has no destination or window", async () => {
    const routeId = await seedRoute(2, {});

    const data = await cancelAndReadPayload(routeId);

    // One shape per topic: absent facts are null, never a missing key.
    expect(data).toMatchObject({
      scheduled_date: "2026-09-17",
      destination: null,
      planned_departure_at: null,
      planned_arrival_at: null,
    });
  });
});

describe("GET /integration/v1/routes/:id", () => {
  it("answers the destination and the planned window", async () => {
    const routeId = await seedRoute(3, {
      destination: "Zona Leste",
      planned_departure_at: new Date("2026-09-17T10:00:00.000Z"),
      planned_arrival_at: new Date("2026-09-17T19:30:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: `/integration/v1/routes/${routeId}`,
      headers: { authorization: `Bearer ${routesKey}` },
    });

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const body = response.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      id: routeId,
      destination: "Zona Leste",
      planned_departure_at: "2026-09-17T10:00:00.000Z",
      planned_arrival_at: "2026-09-17T19:30:00.000Z",
    });
  });

  it("answers null, not a missing key, when nothing was planned", async () => {
    const routeId = await seedRoute(4, {});

    const response = await app.inject({
      method: "GET",
      url: `/integration/v1/routes/${routeId}`,
      headers: { authorization: `Bearer ${routesKey}` },
    });

    const body = response.json() as Record<string, unknown>;

    expect(body).toHaveProperty("destination", null);
    expect(body).toHaveProperty("planned_departure_at", null);
    expect(body).toHaveProperty("planned_arrival_at", null);
  });
});
