import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
  releaseParkedWebhookDeliveries,
} from "@/shared/integration/webhook-dispatch-service";

import {
  MAX_CONSECUTIVE_FAILURES,
  REPLAY_WINDOW_DAYS,
} from "@/shared/integration/webhook-dispatch-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * An endpoint that may not be delivered to, and what happens to its events.
 *
 * Two switches turn an endpoint off: the customer's `is_active`, and our
 * breaker's `disabled_at`. Both were read by the fan-out only.
 *
 * - The rows already queued kept going out: a customer who paused an endpoint
 *   because its URL now points at a system being decommissioned kept sending
 *   it recipient names and NF-e keys for seven more hours, and a breaker that
 *   had just tripped still paid ten seconds per queued row.
 * - While the breaker was open, the fan-out wrote nothing at all. Twenty
 *   failures at 02:00 during the customer's outage, a fix at 09:00: seven
 *   hours of events gone, with no notice to anybody.
 *
 * Now an endpoint that cannot be delivered to HOLDS its queue — no DNS, no
 * fetch, no failure counted — for up to the replay window, and releases it
 * when somebody saves the endpoint again. The breaker tells the company's
 * admins it tripped.
 */
const prisma = createPrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000b5";

const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server;
let baseUrl = "";
let received: string[] = [];
let reply = { status: 200, body: "ok" };

const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();

    request.on("end", () => {
      received.push(request.url ?? "");
      response.writeHead(reply.status, { "Content-Type": "text/plain" });
      response.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Endpoint Pausado",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000144",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "pausado@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  received = [];
  reply = { status: 200, body: "ok" };

  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedEndpoint(
  data: { consecutive_failures?: number } = {},
): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "ERP do cliente",
      url: `${baseUrl}/hook`,
      secret: "whsec_teste_do_pausado",
      topics: ["delivery.*"],
      businessId: CARRIER,
      ...data,
    },
  });

  return endpoint.id;
}

async function announce(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { index },
    });
  }
}

function rows() {
  return prisma.webhookDelivery.findMany({ where: { businessId: CARRIER } });
}

describe("rows queued before the endpoint was switched off", () => {
  it.each([
    ["paused by the customer", { is_active: false }],
    ["switched off by the breaker", { disabled_at: new Date() }],
  ])("are held, not sent, when it was %s", async (_label, switchOff) => {
    const endpointId = await seedEndpoint();

    await announce();

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: switchOff,
    });

    await dispatcher.processBatch();

    expect(received, "o evento saiu para um endpoint desligado").toHaveLength(
      0,
    );

    const [row] = await rows();

    // Held: not an attempt, not a failure, and out of the claim's way until
    // the replay window runs out.
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.availableAt.getTime()).toBeGreaterThan(
      Date.now() + (REPLAY_WINDOW_DAYS - 1) * DAY_MS,
    );
    expect(row.lastError).toMatch(/pausado ou desligado/);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.consecutive_failures).toBe(0);
  });

  it("go out once the endpoint is back", async () => {
    const endpointId = await seedEndpoint();

    await announce();

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: new Date() },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(0);

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: null },
    });

    expect(await releaseParkedWebhookDeliveries(endpointId)).toBe(1);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const [row] = await rows();

    expect(row.status).toBe("DELIVERED");
  });

  it("are closed, without a network call, once the replay window is over", async () => {
    const endpointId = await seedEndpoint();

    await announce();

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        created_at: new Date(Date.now() - (REPLAY_WINDOW_DAYS + 1) * DAY_MS),
      },
    });

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { is_active: false },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(0);

    const [row] = await rows();

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/dias sem poder ser entregue/);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.consecutive_failures).toBe(0);
  });
});

describe("a held row whose replay window ran out", () => {
  it("is not sent when the endpoint comes back too late", async () => {
    const endpointId = await seedEndpoint();

    await announce();

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: new Date() },
    });

    await dispatcher.processBatch();

    // Thirty-one days on: the hold ran out, and only then is the endpoint
    // saved again. The release leaves this row alone; its own due date comes.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        created_at: new Date(Date.now() - (REPLAY_WINDOW_DAYS + 1) * DAY_MS),
        availableAt: new Date(Date.now() - 60_000),
      },
    });

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: null },
    });

    expect(await releaseParkedWebhookDeliveries(endpointId)).toBe(0);

    await dispatcher.processBatch();

    expect(
      received,
      "um evento de fora da janela de 30 dias foi enviado",
    ).toHaveLength(0);

    const [row] = await rows();

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/dias sem poder ser entregue/);
  });
});

describe("events that happen while the breaker is open", () => {
  it("are kept and delivered once the endpoint is back", async () => {
    const endpointId = await seedEndpoint();

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: new Date() },
    });

    await announce(3);

    const held = await rows();

    expect(
      held,
      "eventos gerados com o disjuntor aberto foram descartados",
    ).toHaveLength(3);

    for (const row of held) {
      expect(row.status).toBe("PENDING");
      expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    }

    await dispatcher.processBatch();

    expect(received).toHaveLength(0);

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: null },
    });

    await releaseParkedWebhookDeliveries(endpointId);

    await dispatcher.processBatch();

    expect(received).toHaveLength(3);
  });

  it("but not while the customer paused it: their switch means unsubscribed", async () => {
    await prisma.webhookEndpoint.create({
      data: {
        name: "Pausado",
        url: `${baseUrl}/hook`,
        secret: "whsec_teste_do_pausado",
        topics: ["delivery.*"],
        businessId: CARRIER,
        is_active: false,
      },
    });

    await announce(2);

    expect(await rows()).toHaveLength(0);
  });
});

describe("the breaker tripping", () => {
  it("tells the company, once", async () => {
    const endpointId = await seedEndpoint({
      consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1,
    });

    reply = { status: 503, body: "fora do ar" };

    await announce(2);

    await dispatcher.processBatch();

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.disabled_at).not.toBeNull();

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "webhook-endpoint.disabled", aggregateId: endpointId },
    });

    expect(notices, "o desligamento não avisou ninguém").toHaveLength(1);
    expect(notices[0].businessId).toBe(CARRIER);
  });

  it("tells the company when a 410 switches the endpoint off, too", async () => {
    const endpointId = await seedEndpoint();

    reply = { status: 410, body: "não envie mais" };

    await announce();

    await dispatcher.processBatch();

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "webhook-endpoint.disabled", aggregateId: endpointId },
    });

    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0].payload)).toContain("410");
  });
});
