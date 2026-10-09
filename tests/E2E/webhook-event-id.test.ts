import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebhookDispatchService } from "@/shared/integration/webhook-dispatch-service";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { buildResendRow } from "@/shared/integration/webhook-resend";

/**
 * The id a receiver deduplicates on.
 *
 * Delivery is at-least-once: a receiver that answers 200 after our timeout is
 * sent the event again, and an operator can press "reenviar". The body never
 * carried an `id` — the only caller in production never passed one — and
 * `X-Trajetto-Delivery` is the id of the attempt ROW, which a manual resend
 * replaces. So the second copy of `delivery.delivered` looked like a new fact,
 * and the customer's ERP booked the delivery twice.
 *
 * Driven through `WebhookFanOutService.announce`, the path every use case
 * takes, and through `buildResendRow`, what the resend button queues.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000e1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Received {
  body: string;
  url?: string;
  headers: Record<string, string | undefined>;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];

// The receiver runs on 127.0.0.1, which the real destination check refuses —
// rightly. This file measures what is sent, not where it may go.
const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

const announcer = new WebhookFanOutService();

async function seedEndpoint(path: string): Promise<void> {
  await prisma.webhookEndpoint.create({
    data: {
      name: `Receptor ${path}`,
      url: `${baseUrl}${path}`,
      secret: "whsec_teste_do_id_do_evento",
      topics: ["delivery.delivered"],
      businessId: CARRIER,
    },
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        url: request.url,
        headers: request.headers as Record<string, string | undefined>,
      });

      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do id do evento",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000166",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "evento@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  received = [];

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the id a receiver deduplicates on", () => {
  it("is in the body and in a header, and they agree", async () => {
    await seedEndpoint("/hook");

    await announcer.announce("delivery.delivered", CARRIER, {
      delivery_id: "d1",
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const id = JSON.parse(received[0].body).id;

    expect(id).toMatch(UUID);
    expect(received[0].headers["x-trajetto-event-id"]).toBe(id);
  });

  it("is one id per fact, whichever endpoint receives it", async () => {
    await seedEndpoint("/erp");
    await seedEndpoint("/bi");

    await announcer.announce("delivery.delivered", CARRIER, {
      delivery_id: "d2",
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);

    const ids = received.map((request) => JSON.parse(request.body).id);

    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toBe(ids[0]);
  });

  it("survives a manual resend, while the attempt id changes", async () => {
    await seedEndpoint("/hook");

    await announcer.announce("delivery.delivered", CARRIER, {
      delivery_id: "d3",
    });

    await dispatcher.processBatch();

    const original = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    await prisma.webhookDelivery.create({ data: buildResendRow(original) });

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);

    const [first, second] = received;

    expect(JSON.parse(second.body).id).toBe(JSON.parse(first.body).id);

    expect(second.headers["x-trajetto-event-id"]).toBeDefined();
    expect(second.headers["x-trajetto-event-id"]).toBe(
      first.headers["x-trajetto-event-id"],
    );

    // The attempt is a different row; that id is for support, not for dedup.
    expect(second.headers["x-trajetto-delivery"]).not.toBe(
      first.headers["x-trajetto-delivery"],
    );
  });

  it("stays stable for a row queued before the id existed", async () => {
    // Rows written before this change have no id in their signed bytes, and
    // the bytes cannot change. The header still gives them one, and the
    // resend of such a row carries the same one.
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Receptor antigo",
        url: `${baseUrl}/legacy`,
        secret: "whsec_teste_do_id_do_evento",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
      },
    });

    const body = JSON.stringify({
      topic: "delivery.delivered",
      created_at: new Date().toISOString(),
      data: { delivery_id: "legado" },
    });

    const legacy = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: JSON.parse(body),
        signed_body: body,
        signature: "t=0,v1=00",
      },
    });

    await dispatcher.processBatch();

    await prisma.webhookDelivery.create({
      data: buildResendRow(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: legacy.id },
        }),
      ),
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);
    expect(received[0].headers["x-trajetto-event-id"]).toBe(legacy.id);
    expect(received[1].headers["x-trajetto-event-id"]).toBe(legacy.id);
  });
});
