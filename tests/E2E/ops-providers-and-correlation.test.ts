import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import pino from "pino";
import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Contract §32/§33 on the real app and the real database:
 *
 *  - /health/providers says which providers are configured and answering,
 *    MASTER-only, with variable names and never their values;
 *  - /health/metrics carries provider latency/error rate per channel, the
 *    replica's sockets and Redis;
 *  - a dead-letter row leads back to the HTTP request that caused it: the
 *    event's correlation id (the x-request-id) was in the table and nowhere
 *    on the screen an operator reads during an incident.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MASTER = "018fda00-0000-7000-8000-0000000000a1";
const CARRIER = "018fda00-0000-7000-8000-0000000000b1";
const OTHER_CARRIER = "018fda00-0000-7000-8000-0000000000b2";
const STAFF = "018fda00-0000-7000-8000-0000000000c1";
const OTHER_STAFF = "018fda00-0000-7000-8000-0000000000c2";

const EVENT = randomUUID();
const CORRELATION = "web-ops-correlation-0001";

let masterToken = "";
let staffToken = "";
let otherStaffToken = "";
let failedDeliveryId = "";
let written = "";

const capture = {
  write(chunk: string) {
    written += chunk;
  },
};

const lines = () =>
  written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function tokenFor(
  userId: string,
  role: string,
  businessId: string | null = null,
) {
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
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

function business(id: string, name: string) {
  return {
    id,
    corporate_reason: name,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    cnpj: String(52000000000000 + Math.floor(Math.random() * 9000000)),
    cnae: "4930202",
    responsible_name: "Responsável",
    telephone: "11999999999",
    email: `ops-${randomUUID()}@exemplo.com.br`,
  };
}

beforeAll(async () => {
  await prisma.business.createMany({
    data: [
      business(CARRIER, "Transportadora Operação"),
      business(OTHER_CARRIER, "Outra Transportadora"),
    ],
  });

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        name: "Master Ops",
        email: `m-${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "MASTER",
      },
      {
        id: STAFF,
        name: "Gestora",
        email: `s-${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
      {
        id: OTHER_STAFF,
        name: "Usuário",
        email: `o-${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_USER",
        businessId: OTHER_CARRIER,
      },
    ],
  });

  masterToken = await tokenFor(MASTER, "MASTER");
  staffToken = await tokenFor(STAFF, "BUSINESS_ADMIN", CARRIER);
  otherStaffToken = await tokenFor(OTHER_STAFF, "BUSINESS_USER", OTHER_CARRIER);

  await prisma.domainOutboxEvent.create({
    data: {
      id: EVENT,
      eventKey: `ops-dead-letter-${EVENT}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: CARRIER,
      payload: {},
      status: "PUBLISHED",
      correlationId: CORRELATION,
    },
  });

  // In the future, so it heads the dead letter whatever else the shared
  // database holds.
  failedDeliveryId = (
    await prisma.notificationDelivery.create({
      data: {
        outboxEventId: EVENT,
        userId: STAFF,
        channel: "EMAIL",
        status: "FAILED",
        attempts: 8,
        lastError: "[email smtp=EAUTH] Falha ao enviar e-mail",
        updated_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();

  // Every line the shared logger (and its children) writes lands here.
  const { logger } = await import("@/shared/logging/logger");
  (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] =
    capture;
}, 120_000);

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.notificationDelivery.deleteMany({
    where: { outboxEventId: EVENT },
  });
  await prisma.domainOutboxEvent.deleteMany({ where: { id: EVENT } });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [MASTER, STAFF, OTHER_STAFF] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [MASTER, STAFF, OTHER_STAFF] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [CARRIER, OTHER_CARRIER] } },
  });

  await app?.close();
  await prisma.$disconnect();
});

function get(url: string, token?: string) {
  return app.inject({
    method: "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("who may read the providers' readiness", () => {
  it("refuses an anonymous caller with 401", async () => {
    expect((await get("/health/providers")).statusCode).toBe(401);
  });

  it("refuses a company administrator with 403", async () => {
    const response = await get("/health/providers", staffToken);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
  });

  it("refuses a user of another company with 403 and no provider data", async () => {
    const response = await get("/health/providers", otherStaffToken);

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty("providers");
  });
});

describe("the providers' readiness, for the MASTER", () => {
  it("lists every provider with a status, and no secret value", async () => {
    const response = await get("/health/providers?refresh=true", masterToken);

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.cached).toBe(false);
    expect(body.providers.map((p: { key: string }) => p.key)).toEqual([
      "email",
      "whatsapp",
      "push",
      "storage",
      "ai_ocr",
      "proof_certificate",
      "heartbeat",
    ]);

    for (const provider of body.providers) {
      expect([
        "ok",
        "warning",
        "error",
        "not_configured",
        "disabled",
      ]).toContain(provider.status);
    }

    // The test stack runs without Meta credentials: named, not valued.
    const whatsapp = body.providers.find(
      (p: { key: string }) => p.key === "whatsapp",
    );
    if (!process.env.META_WHATSAPP_ACCESS_TOKEN) {
      expect(whatsapp.status).toBe("not_configured");
      expect(whatsapp.missing_env).toContain("META_WHATSAPP_ACCESS_TOKEN");
    }

    const text = response.body;
    for (const key of [
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_SECRET",
      "JWT_SECRET_REFRESH_TOKEN",
      "AI_LOCAL_TOKEN",
      "RESEND_SECRET_KEY",
      "META_WHATSAPP_ACCESS_TOKEN",
      "R2_SECRET_ACCESS_KEY",
      "HEALTHCHECK_PING_URL",
    ]) {
      const value = process.env[key];
      if (value && value.length >= 8) expect(text).not.toContain(value);
    }
  }, 30_000);

  it("answers from its 30-second cache the second time", async () => {
    const response = await get("/health/providers", masterToken);

    expect(response.statusCode).toBe(200);
    expect(response.json().cached).toBe(true);
  }, 30_000);

  it("refuses a refresh flag that is not a boolean", async () => {
    const response = await get("/health/providers?refresh=sim", masterToken);

    expect(response.statusCode).toBe(400);
  });
});

describe("the operational metrics", () => {
  it("carry provider latency per channel, the sockets and Redis", async () => {
    const response = await get("/health/metrics", masterToken);

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(
      body.providers.channels.map((c: { channel: string }) => c.channel),
    ).toEqual(["EMAIL", "WHATSAPP", "PUSH", "AI_OCR", "WEBHOOK"]);
    expect(typeof body.realtime.local_connections).toBe("number");
    expect(body.redis.status).toBe("up");
    expect(body.redis.latency_ms).not.toBeNull();
  });
});

describe("a dead-letter row", () => {
  it("names the event and the request that caused it", async () => {
    const response = await get(
      "/health/dead-letter?channel=EMAIL&pageSize=5",
      masterToken,
    );

    expect(response.statusCode).toBe(200);

    const row = response
      .json()
      .data.find((entry: { id: string }) => entry.id === failedDeliveryId);

    expect(row).toMatchObject({ eventId: EVENT, correlationId: CORRELATION });
  });

  it("stays MASTER-only", async () => {
    expect((await get("/health/dead-letter", staffToken)).statusCode).toBe(403);
  });
});

describe("a webhook event published inside a request", () => {
  it("logs the request id next to the event id the customer receives", async () => {
    /**
     * HTTP -> webhook: the dispatcher's rows carry the public event id
     * (X-Trajetto-Event-Id) and nothing tied it to the request that caused
     * it. One line at fan-out now does.
     */
    await prisma.webhookEndpoint.create({
      data: {
        name: "Cliente rastreável",
        url: "https://cliente.exemplo.com.br/hook",
        secret: "whsec_teste",
        topics: ["delivery.*"],
        businessId: CARRIER,
      },
    });

    const { enterRequestContext } = await import(
      "@/shared/http/request-context"
    );
    const { fanOutWebhookEvent } = await import(
      "@/shared/integration/webhook-dispatch-service"
    );
    const database = (await import("@/../infra/database")).default;

    enterRequestContext({ requestId: "req-ops-webhook-0001" });

    const fanned = await fanOutWebhookEvent(
      { topic: "delivery.created", businessId: CARRIER, payload: { id: "x" } },
      database,
    );

    expect(fanned).toBe(1);

    const line = lines().find(
      (entry) => entry.msg === "webhook event fanned out",
    );

    expect(line).toMatchObject({
      correlationId: "req-ops-webhook-0001",
      topic: "delivery.created",
      businessId: CARRIER,
      endpoints: 1,
    });

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(line?.sourceEventId).toBe(row.sourceEventId);
  });
});
