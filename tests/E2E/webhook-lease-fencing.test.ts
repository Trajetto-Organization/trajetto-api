import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

/**
 * Who may write the outcome of a send, and when the process may leave.
 *
 * The outcome writes were `where: { id }`: a worker whose lease ran out — a
 * slow DNS, a pool wait, a GC pause — came back after another replica had
 * reclaimed the row, delivered it and recorded DELIVERED, and overwrote that
 * with its own stale verdict. A PENDING written over a DELIVERED is a third
 * copy of the event on the customer's side, and a failure counted against an
 * endpoint that had just answered 200.
 *
 * And shutdown returned at once, with a batch in flight: every deploy cut
 * sends between the customer's answer and our record of it, and each of those
 * went out again when the lease expired.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000f7";

let server: Server;
let baseUrl = "";

/** Requests to `/hold` wait here until the test answers them. */
let held: Array<{ response: ServerResponse; request: IncomingMessage }> = [];
let arrivals = 0;

const SLOW_MS = 1_500;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();

    request.on("end", () => {
      arrivals += 1;

      if (request.url === "/hold" && held.length === 0 && arrivals === 1) {
        held.push({ request, response });
        return;
      }

      const answer = () => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("ok");
      };

      if (request.url === "/slow") setTimeout(answer, SLOW_MS);
      else answer();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Lease",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000155",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "lease@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  held = [];
  arrivals = 0;

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  for (const entry of held) entry.response.destroy();

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedEndpoint(path: string): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "Receptor",
      url: `${baseUrl}${path}`,
      secret: "whsec_teste_do_lease",
      topics: ["delivery.delivered"],
      businessId: CARRIER,
    },
  });

  return endpoint.id;
}

async function until(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condição não atingida a tempo");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a worker that lost its lease", () => {
  it("cannot overwrite the outcome of the one that took over", async () => {
    const endpointId = await seedEndpoint("/hold");

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    const permissive = async () => ({ allowed: true });

    // Worker A sends, and its receiver takes its time answering.
    const late = new WebhookDispatchService(permissive);
    const lateBatch = late.processBatch();

    await until(() => held.length === 1);

    // A's lease runs out while it waits. The claim writes the lease end into
    // availableAt too (PG-19), so time running out moves both.
    const expired = new Date(Date.now() - 1_000);

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: { leaseExpiresAt: expired, availableAt: expired },
    });

    // Worker B reclaims the row, sends it and records the 200.
    await new WebhookDispatchService(permissive).processBatch();

    const taken = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(taken.status).toBe("DELIVERED");

    // A's call finally fails. Its verdict is stale.
    const [{ response }] = held;

    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("tarde demais");

    await lateBatch;

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(row.status, "o worker atrasado reabriu uma entrega já feita").toBe(
      "DELIVERED",
    );
    expect(row.response_status).toBe(200);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.consecutive_failures).toBe(0);
  }, 30_000);
});

describe("shutting down with a batch in flight", () => {
  it("waits for the send to be recorded before returning", async () => {
    await seedEndpoint("/slow");

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    const dispatcher = new WebhookDispatchService(async () => ({
      allowed: true,
    }));

    const batch = dispatcher.processBatch();

    await until(() => arrivals === 1);

    await dispatcher.shutdown();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(
      row.status,
      "o shutdown voltou antes de registrar um envio que o receptor já tinha aceitado",
    ).toBe("DELIVERED");

    await batch;
  }, 30_000);
});
