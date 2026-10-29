import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";
import { WEBHOOK_MAX_ATTEMPTS } from "@/shared/integration/webhook-dispatch-rules";
import { sealSecret } from "@/shared/integration/secret-box";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A webhook whose stored credentials cannot be opened.
 *
 * The signing secret and the customer's headers are sealed under
 * WEBHOOK_SECRETS_KEY. When that key is missing or wrong (a deploy that lost
 * the variable, a restore under another key), nothing can be signed — and it
 * is our fault, not the receiver's. The send used to throw and leave the row
 * to its lease: reclaimed every two minutes, the whole retry budget burned in
 * a quarter of an hour, and the row closed as "O processo foi interrompido" —
 * a reason that sent whoever read the monitor looking in the wrong place, and
 * a key fixed within the documented retry window no longer helped.
 *
 * Now it is an attempt like any other that did not reach the receiver: on the
 * retry schedule, with the reason, never counted against the endpoint.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdc81-0000-7000-8000-00000000000a";

let server: Server;
let baseUrl = "";
const received: string[] = [];

const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push(request.url ?? "");
    response.writeHead(200);
    response.end("ok");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Chave Perdida",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `chave-${randomUUID()}@exemplo.com.br`,
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An endpoint and one queued event for it. */
async function queued(credentials: {
  secret: string;
  headers?: Record<string, string>;
}) {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `Endpoint ${randomUUID().slice(0, 8)}`,
      url: `${baseUrl}/hook`,
      secret: credentials.secret,
      ...(credentials.headers && { headers: credentials.headers }),
      topics: ["route.released"],
      businessId: CARRIER,
    },
  });

  await fanOutWebhookEvent({
    topic: "route.released",
    businessId: CARRIER,
    payload: { route_id: randomUUID() },
  });

  const row = await prisma.webhookDelivery.findFirstOrThrow({
    where: { endpointId: endpoint.id },
  });

  return { endpoint, row };
}

/** Sealed under a key this process does not have. */
const foreignSeal = (value: string) => sealSecret(value, randomBytes(32));

async function settledEndpoint(id: string) {
  return prisma.webhookEndpoint.findUniqueOrThrow({
    where: { id },
    select: { consecutive_failures: true, disabled_at: true },
  });
}

describe("a secret that cannot be opened", () => {
  it("is retried on the schedule, with the reason, and blames nobody", async () => {
    const { endpoint, row } = await queued({
      secret: foreignSeal("whsec_de_outra_chave"),
    });

    received.length = 0;
    const before = Date.now();

    await dispatcher.processBatch();

    const after = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(received).toHaveLength(0);

    // Handed back to the schedule, not left to its lease.
    expect(after.status).toBe("PENDING");
    expect(after.leaseExpiresAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.availableAt.getTime()).toBeGreaterThan(before);
    expect(after.lastError).toMatch(/credenciais/i);

    expect(await settledEndpoint(endpoint.id)).toEqual({
      consecutive_failures: 0,
      disabled_at: null,
    });

    await prisma.webhookDelivery.deleteMany({
      where: { endpointId: endpoint.id },
    });
    await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  });

  it("closes the row with that reason once the schedule runs out", async () => {
    const { endpoint, row } = await queued({
      secret: foreignSeal("whsec_de_outra_chave"),
    });

    // The last attempt the schedule allows is due now.
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        attempts: WEBHOOK_MAX_ATTEMPTS - 1,
        availableAt: new Date(Date.now() - 1000),
      },
    });

    received.length = 0;

    await dispatcher.processBatch();

    const after = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(received).toHaveLength(0);
    expect(after.status).toBe("FAILED");
    expect(after.lastError).toMatch(/credenciais/i);

    // Our key, not their server: no streak, no switch-off.
    expect(await settledEndpoint(endpoint.id)).toEqual({
      consecutive_failures: 0,
      disabled_at: null,
    });

    await prisma.webhookDelivery.deleteMany({
      where: { endpointId: endpoint.id },
    });
    await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  });
});

describe("headers that cannot be opened", () => {
  it("are handled like the secret: nothing sent without them", async () => {
    const { endpoint, row } = await queued({
      secret: sealSecret("whsec_legivel"),
      headers: {
        "enc:v1": foreignSeal(JSON.stringify({ Authorization: "Bearer x" })),
      },
    });

    received.length = 0;

    await dispatcher.processBatch();

    const after = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(received).toHaveLength(0);
    expect(after.status).toBe("PENDING");
    expect(after.lastError).toMatch(/credenciais/i);

    expect(await settledEndpoint(endpoint.id)).toEqual({
      consecutive_failures: 0,
      disabled_at: null,
    });

    await prisma.webhookDelivery.deleteMany({
      where: { endpointId: endpoint.id },
    });
    await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  });
});
