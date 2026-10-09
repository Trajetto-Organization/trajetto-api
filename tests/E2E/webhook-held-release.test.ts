import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
  releaseParkedWebhookDeliveries,
} from "@/shared/integration/webhook-dispatch-service";

import { ENDPOINT_PAUSED_REASON } from "@/shared/integration/webhook-dispatch-rules";

/**
 * Releasing what an endpoint held while it was off, when somebody saves it
 * again.
 *
 * - The release was ONE statement, inside the save's transaction. At about
 *   forty microseconds a row, a month of held events for a busy tenant took
 *   longer than the transaction may run (15 s) and than any statement may run
 *   in production (30 s): the save failed, and failed again on every retry —
 *   the endpoint could not be switched back on at all.
 * - A row written held by somebody who read the endpoint as switched off just
 *   before the save committed — a worker parking a row, an event in a
 *   transaction still open — landed after the release had looked. It sat out
 *   the whole thirty days on an endpoint that was working, and was then
 *   closed unsent.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000c3";

let server: Server;
let baseUrl = "";
let received: string[] = [];

const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();

    request.on("end", () => {
      received.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Liberação",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000166",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "liberacao@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  received = [];

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

/** An endpoint our breaker switched off. */
async function switchedOffEndpoint(): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "ERP que caiu",
      url: `${baseUrl}/hook`,
      secret: "whsec_teste_da_liberacao",
      topics: ["delivery.*"],
      businessId: CARRIER,
      disabled_at: new Date(),
      consecutive_failures: 20,
    },
  });

  return endpoint.id;
}

/** What the save does once it has switched the endpoint back on. */
async function saveActive(endpointId: string): Promise<void> {
  await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { disabled_at: null, consecutive_failures: 0, is_active: true },
  });

  await releaseParkedWebhookDeliveries(endpointId);
}

function heldRows() {
  return prisma.webhookDelivery.count({
    where: { businessId: CARRIER, status: "PENDING", availableAt: { gt: new Date() } },
  });
}

describe("a month of held events", () => {
  it("is released in statements that each fit the database's time limit", async () => {
    const endpointId = await switchedOffEndpoint();

    const HELD = 40_000;

    await prisma.$executeRaw`
      INSERT INTO "webhook_delivery" (
        "id", "endpointId", "businessId", "topic", "payload", "signature",
        "signed_body", "availableAt", "lastError", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, ${endpointId}, ${CARRIER}, 'delivery.delivered',
             '{}'::jsonb, '', '{}', now() + interval '29 days', ${ENDPOINT_PAUSED_REASON},
             now() - interval '1 day' + g * interval '1 millisecond', now()
      FROM generate_series(1, ${HELD}::int) AS g
    `;

    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabled_at: null },
    });

    // Production caps every statement (statement_timeout in DATABASE_URL).
    // Here the cap is scaled down with the backlog: one statement over all
    // 40 000 rows takes well over it, a bounded batch well under it.
    const url = new URL(process.env.DATABASE_URL as string);
    url.searchParams.set("options", "-c statement_timeout=600");

    const capped = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    try {
      await expect(
        releaseParkedWebhookDeliveries(endpointId, capped),
        "a liberação estourou o limite de tempo de uma instrução",
      ).resolves.toBe(HELD);
    } finally {
      await capped.$disconnect();
    }

    expect(await heldRows()).toBe(0);
  }, 120_000);
});

describe("a row parked by a worker that read the endpoint just before the save", () => {
  it("is sent, not held for thirty days on a working endpoint", async () => {
    const endpointId = await switchedOffEndpoint();

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "d1" },
    });

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId },
    });

    // A worker claims the row (as claim() leaves it) and reads the endpoint:
    // still switched off.
    const leaseEnd = new Date(Date.now() + 120_000);

    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: leaseEnd,
        availableAt: leaseEnd,
      },
    });

    // The save lands now. Its release cannot see a row in flight.
    await saveActive(endpointId);

    // The worker acts on what it read: it parks the row.
    await (
      dispatcher as unknown as { park(row: object): Promise<void> }
    ).park({
      id: row.id,
      endpointId,
      topic: row.topic,
      payload: row.payload,
      attempts: 1,
      created_at: row.created_at,
    });

    await dispatcher.processBatch();

    expect(
      received,
      "a linha estacionada depois do salvamento ficou retida num endpoint que funciona",
    ).toHaveLength(1);
  }, 30_000);
});

describe("an event written in a transaction still open when the endpoint is saved", () => {
  it("is not left behind by the release", async () => {
    const endpointId = await switchedOffEndpoint();

    let saving: Promise<void> | undefined;

    await prisma.$transaction(
      async (tx) => {
        // The business write and its event: the endpoint reads as switched
        // off, so the row is written held.
        await fanOutWebhookEvent(
          {
            topic: "delivery.delivered",
            businessId: CARRIER,
            payload: { delivery_id: "d2" },
          },
          tx,
        );

        // Somebody saves the endpoint while this transaction is still open.
        saving = saveActive(endpointId);

        // Time for the save to run to the end, if nothing makes it wait.
        await new Promise((resolve) => setTimeout(resolve, 750));
      },
      { timeout: 10_000 },
    );

    await saving;

    expect(
      await heldRows(),
      "o evento gravado durante o salvamento ficou retido por 30 dias",
    ).toBe(0);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);
  }, 30_000);
});
