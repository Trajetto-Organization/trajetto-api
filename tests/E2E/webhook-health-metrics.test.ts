import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { ENDPOINT_PAUSED_REASON } from "@/shared/integration/webhook-dispatch-rules";

/**
 * What an operator can see of the webhook queue.
 *
 * `/health/metrics` covered the outbox, the notification lanes and the AI
 * queue, and nothing of webhooks: an endpoint switched off by the breaker, a
 * queue of held events, a backlog nobody was draining — none of it showed
 * anywhere but in a customer's reconciliation.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MASTER = "018fd910-0000-7000-8000-0000000000m1";
const CARRIER = "018fd910-0000-7000-8000-00000000000a";

let token = "";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Métricas de Webhook",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(55000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `webhook-metrics-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MASTER,
      name: "Master das Métricas de Webhook",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: MASTER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "MASTER",
      businessId: null,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: MASTER, expiresIn: "1h" },
  );

  // One endpoint our breaker switched off, one working.
  const off = await prisma.webhookEndpoint.create({
    data: {
      name: "Desligado",
      url: "https://desligado.exemplo.com.br/hook",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
      disabled_at: new Date(),
    },
  });

  const on = await prisma.webhookEndpoint.create({
    data: {
      name: "Ligado",
      url: "https://ligado.exemplo.com.br/hook",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  const row = (endpointId: string, availableAt: Date, lastError?: string) => ({
    endpointId,
    businessId: CARRIER,
    topic: "delivery.delivered",
    payload: {},
    signed_body: "{}",
    signature: "",
    availableAt,
    lastError,
  });

  await prisma.webhookDelivery.createMany({
    data: [
      // Held for the switched-off endpoint, weeks ahead.
      row(off.id, new Date(Date.now() + 29 * DAY_MS), ENDPOINT_PAUSED_REASON),
      row(off.id, new Date(Date.now() + 29 * DAY_MS), ENDPOINT_PAUSED_REASON),
      // Held too, in the last hours of its window: still held, and the one
      // an operator most needs to see before it is closed unsent.
      row(off.id, new Date(Date.now() + 2 * 60 * 60 * 1000), ENDPOINT_PAUSED_REASON),
      // Due for ten minutes and not sent: a backlog.
      row(on.id, new Date(Date.now() - 10 * 60 * 1000)),
      // Waiting out a backoff: neither due nor held.
      row(on.id, new Date(Date.now() + 60 * 60 * 1000)),
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.refreshToken.deleteMany({ where: { userId: MASTER } });
  await prisma.user.deleteMany({ where: { id: MASTER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("/health/metrics, on webhooks", () => {
  it("shows the switched-off endpoints, the held events and the age of the backlog", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/metrics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const { webhooks } = response.json();

    expect(webhooks, "o /health/metrics não diz nada sobre webhooks").toBeDefined();

    expect(webhooks.disabled_endpoints).toBe(1);
    expect(webhooks.held, "linhas retidas no último dia da janela ficaram de fora").toBe(3);
    expect(webhooks.pending_due).toBe(1);
    expect(webhooks.oldest_due_seconds).toBeGreaterThanOrEqual(10 * 60 - 5);
  });
});
