import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { fanOutWebhookEvent } from "@/shared/integration/webhook-dispatch-service";
import { openHeaders } from "@/shared/integration/secret-box";

/**
 * The admin screens' side of an endpoint: what an edit keeps, and what a
 * resend may do.
 *
 * Over HTTP, through the real routes, because both defects lived in the
 * controller: an edit that wrote `headers ?? null` and a resend that never
 * looked at the endpoint it was sending to.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdb10-0000-7000-8000-00000000000a";
const ADMIN = "018fdb10-0000-7000-8000-0000000000a1";

let token = "";

async function tokenFor(userId: string, businessId: string): Promise<string> {
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
      role: "BUSINESS_ADMIN",
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Endpoints",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(54000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `endpoints-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora dos Endpoints",
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  token = await tokenFor(ADMIN, CARRIER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { businessId: CARRIER } });
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });

  await prisma.refreshToken.deleteMany({ where: { userId: ADMIN } });
  await prisma.user.deleteMany({ where: { id: ADMIN } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

function call(method: "POST" | "PUT", url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as never }),
  });
}

describe("editing an endpoint", () => {
  it("keeps the headers configured through the API when the screen omits them", async () => {
    // The web form has no headers field and never sends one. Every save
    // through it used to write `headers: null`, wiping the Authorization the
    // integrator configured through the API: the receiver started answering
    // 401 and, twenty events later, the endpoint was switched off.
    const created = await call(
      "POST",
      `/integrations/webhook-endpoint/${CARRIER}`,
      {
        name: "ERP com gateway",
        url: "https://erp.exemplo.com.br/webhooks",
        topics: ["delivery.created"],
        headers: { Authorization: "Bearer do-gateway" },
      },
    );

    expect(created.statusCode, created.body).toBe(201);

    const id = created.json().data.id as string;

    const edited = await call(
      "PUT",
      `/integrations/webhook-endpoint/${id}/business/${CARRIER}`,
      {
        name: "ERP com gateway (renomeado)",
        url: "https://erp.exemplo.com.br/webhooks",
        topics: ["delivery.created", "delivery.delivered"],
        is_active: true,
      },
    );

    expect(edited.statusCode, edited.body).toBe(200);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id },
    });

    expect(row.name).toBe("ERP com gateway (renomeado)");
    // Sealed at rest (WH-18): opened to compare.
    expect(openHeaders(row.headers)).toEqual({
      Authorization: "Bearer do-gateway",
    });
  });

  it("clears them when the caller says so, with null", async () => {
    const created = await call(
      "POST",
      `/integrations/webhook-endpoint/${CARRIER}`,
      {
        name: "ERP que troca de gateway",
        url: "https://erp.exemplo.com.br/outro",
        topics: ["delivery.created"],
        headers: { "X-Api-Key": "antiga" },
      },
    );

    expect(created.statusCode, created.body).toBe(201);

    const id = created.json().data.id as string;

    const edited = await call(
      "PUT",
      `/integrations/webhook-endpoint/${id}/business/${CARRIER}`,
      {
        name: "ERP que troca de gateway",
        url: "https://erp.exemplo.com.br/outro",
        topics: ["delivery.created"],
        headers: null,
      },
    );

    expect(edited.statusCode, edited.body).toBe(200);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id },
    });

    expect(row.headers).toBeNull();
  });
});

describe("saving an endpoint our breaker switched off", () => {
  it("sends what it was holding", async () => {
    const created = await call(
      "POST",
      `/integrations/webhook-endpoint/${CARRIER}`,
      {
        name: "ERP que caiu",
        url: "https://erp.exemplo.com.br/caiu",
        topics: ["delivery.*"],
      },
    );

    expect(created.statusCode, created.body).toBe(201);

    const id = created.json().data.id as string;

    await prisma.webhookEndpoint.update({
      where: { id },
      data: { disabled_at: new Date(), consecutive_failures: 20 },
    });

    // Events of the outage: held, not dropped.
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "d1" },
    });

    await fanOutWebhookEvent({
      topic: "delivery.failed",
      businessId: CARRIER,
      payload: { delivery_id: "d2" },
    });

    const edited = await call(
      "PUT",
      `/integrations/webhook-endpoint/${id}/business/${CARRIER}`,
      {
        name: "ERP que caiu",
        url: "https://erp.exemplo.com.br/caiu",
        topics: ["delivery.*"],
        is_active: true,
      },
    );

    expect(edited.statusCode, edited.body).toBe(200);

    const rows = await prisma.webhookDelivery.findMany({
      where: { endpointId: id },
    });

    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(
        row.availableAt.getTime(),
        "salvar o endpoint não liberou os eventos retidos",
      ).toBeLessThanOrEqual(Date.now());
      expect(row.lastError).toBeNull();
    }
  });
});

describe("resending to an endpoint that is switched off", () => {
  it("is held for the endpoint's return, and says so", async () => {
    const created = await call(
      "POST",
      `/integrations/webhook-endpoint/${CARRIER}`,
      {
        name: "ERP pausado",
        url: "https://erp.exemplo.com.br/pausado",
        topics: ["delivery.*"],
        is_active: false,
      },
    );

    expect(created.statusCode, created.body).toBe(201);

    const endpointId = created.json().data.id as string;

    const original = await prisma.webhookDelivery.create({
      data: {
        endpointId,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: {},
        signed_body: "{}",
        signature: "",
        status: "DELIVERED",
      },
    });

    const resent = await call(
      "POST",
      `/integrations/webhook-delivery/${original.id}/business/${CARRIER}/resend`,
    );

    // Accepted, as the screen has always been answered — but not sent to an
    // endpoint the customer switched off, and the sentence says why.
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json().message).toMatch(/pausado ou desligado/);

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: resent.json().data.id },
    });

    expect(row.status).toBe("PENDING");
    expect(row.availableAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
  });
});
