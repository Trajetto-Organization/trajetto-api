import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

import { verifyWebhookSignature } from "@/shared/integration/webhook-signature";

/**
 * The dispatcher against a real database and a real HTTP receiver.
 *
 * Everything else about webhooks is testable in isolation — the signature, the
 * retry schedule, which topics match. What is NOT is the loop: claim under
 * `FOR UPDATE SKIP LOCKED`, post, read the answer, decide, and write the
 * outcome back. Each of those steps is fine on its own and the bugs live
 * between them, which is why this file exists.
 *
 * The receiver here is an actual server on an actual port. A mocked `fetch`
 * would prove we call a function; it would not prove a receiver can verify
 * what arrives, and verification failing on our own retry is the failure mode
 * that costs a customer a week.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-00000000000a";

interface Received {
  body: string;
  headers: Record<string, string | undefined>;
}

let server: Server;
let baseUrl: string;

let received: Received[] = [];

/** What the next request is answered with, so a test can choose the outcome. */
let reply: { status: number; body: string } = { status: 200, body: "ok" };

/**
 * O despachante com um verificador de destino permissivo.
 *
 * O receptor deste arquivo roda em `127.0.0.1`, que é exatamente o que a
 * verificação de destino recusa — e ela está certa. Um verificador injetado
 * deixa os testes de ENTREGA medirem a entrega, enquanto os de RECUSA abaixo
 * usam o verificador de verdade.
 */
const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

/** O de produção, para provar que ele recusa. */
const guardedDispatcher = new WebhookDispatchService();

async function seedEndpoint(options: {
  topics: string[];
  path?: string;
  secret?: string;
  is_active?: boolean;
}): Promise<{ id: string; secret: string }> {
  const secret = options.secret ?? "whsec_teste_do_despachante";

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "Receptor de teste",
      url: `${baseUrl}${options.path ?? "/hook"}`,
      secret,
      topics: options.topics,
      businessId: CARRIER,
      is_active: options.is_active ?? true,
    },
  });

  return { id: endpoint.id, secret };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers as Record<string, string | undefined>,
      });

      response.writeHead(reply.status, { "Content-Type": "text/plain" });
      response.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Despachante",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "despachante@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  received = [];
  reply = { status: 200, body: "ok" };

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

describe("one event reaching one endpoint", () => {
  it("posts it, and the receiver can verify what arrived", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    const queued = await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc", code: "PED-1" },
    });

    expect(queued).toBe(1);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const signature = received[0].headers["x-trajetto-signature"];

    // The whole promise of a webhook: the receiver can tell it came from us.
    // Verified with the SAME function a customer would implement against, on
    // the exact bytes that arrived — not on a re-serialisation of them, which
    // is where this breaks in practice.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[0].body,
        header: signature ?? "",
      }),
    ).toBe(true);

    expect(received[0].headers["x-trajetto-topic"]).toBe("delivery.delivered");
    expect(JSON.parse(received[0].body).data.delivery_id).toBe("abc");

    const row = await prisma.webhookDelivery.findFirst({
      where: { businessId: CARRIER },
    });

    expect(row?.status).toBe("DELIVERED");
    expect(row?.response_status).toBe(200);
    expect(row?.latency_ms).not.toBeNull();
  });

  it("refuses a signature checked against the wrong secret", async () => {
    // The other half of the pair. Without it the check above would pass for a
    // verifier that returns true for anything.
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc" },
    });

    await dispatcher.processBatch();

    expect(
      verifyWebhookSignature({
        secret: "whsec_de_outra_empresa",
        body: received[0].body,
        header: received[0].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(false);
  });
});

describe("who gets an event", () => {
  it("skips an endpoint that did not subscribe to the topic", async () => {
    await seedEndpoint({ topics: ["route.started"] });

    const queued = await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    expect(queued).toBe(0);

    await dispatcher.processBatch();

    expect(received).toHaveLength(0);
  });

  it("matches a one-level wildcard", async () => {
    await seedEndpoint({ topics: ["delivery.*"] });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.cancelled",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(1);

    // And only its own family: `delivery.*` is not a subscription to routes.
    expect(
      await fanOutWebhookEvent({
        topic: "route.started",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(0);
  });

  it("skips an endpoint the customer paused", async () => {
    await seedEndpoint({ topics: ["delivery.*"], is_active: false });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(0);
  });

  it("gives each subscribed endpoint its own row", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"], path: "/um" });
    await seedEndpoint({ topics: ["delivery.*"], path: "/dois" });

    expect(
      await fanOutWebhookEvent({
        topic: "delivery.delivered",
        businessId: CARRIER,
        payload: {},
      }),
    ).toBe(2);

    await dispatcher.processBatch();

    // One failing receiver must not cost the other its event, which is only
    // true because they are separate rows with separate outcomes.
    expect(received).toHaveLength(2);
  });
});

describe("when the receiver does not cooperate", () => {
  it("schedules a retry after a 500 and keeps the body it answered with", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 500, body: "banco de dados indisponível" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);

    // The reason, kept. It is the first thing a customer's engineer is shown,
    // and asking them to reproduce it is asking them to wait for it to happen
    // again.
    expect(row.response_status).toBe(500);
    expect(row.response_body).toContain("banco de dados indisponível");

    // Not immediately: a receiver that is down stays down for a while, and a
    // tight loop against it is an outage we are adding to.
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stops for good on 410 Gone", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 410, body: "não envie mais" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    // A receiver saying "stop sending me this" is the difference between an
    // integration and a nuisance.
    expect(row.status).toBe("FAILED");

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);
  });

  it("counts failures in a row on the endpoint, and resets on a success", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 503, body: "indisponível" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    const afterFailure = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { id: endpoint.id },
    });

    expect(afterFailure.consecutive_failures).toBeGreaterThan(0);

    reply = { status: 200, body: "ok" };

    // A second event, delivered. The counter has to be about a run of
    // failures and not a total — an endpoint that fails once a month would
    // otherwise be switched off eventually for no reason.
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER, status: "PENDING" },
      data: { availableAt: new Date() },
    });

    await dispatcher.processBatch();

    const afterSuccess = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { id: endpoint.id },
    });

    expect(afterSuccess.consecutive_failures).toBe(0);
  });
});

describe("claiming work", () => {
  it("leaves a row scheduled for later alone", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: { availableAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await dispatcher.processBatch()).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("reclaims a row whose lease expired", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // A replica that died mid-send: PROCESSING, with a lease that has run
    // out. Nobody is coming back for it, so somebody else has to.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    expect(await dispatcher.processBatch()).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("does not touch a row whose lease is still running", async () => {
    await seedEndpoint({ topics: ["delivery.delivered"] });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    // Somebody else is sending this right now. Claiming it here is how a
    // receiver gets the same event twice from two replicas.
    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + 60 * 1000),
      },
    });

    expect(await dispatcher.processBatch()).toBe(0);
    expect(received).toHaveLength(0);
  });
});

describe("a retry sends the same bytes", () => {
  it("posts a body the first signature still covers", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    reply = { status: 500, body: "tente de novo" };

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "abc", city: "São Paulo" },
    });

    await dispatcher.processBatch();

    reply = { status: 200, body: "ok" };

    await prisma.webhookDelivery.updateMany({
      where: { businessId: CARRIER },
      data: { availableAt: new Date() },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);

    // Byte-identical, signature included. Signing at send time instead would
    // produce a second body a receiver cannot match to the first — and an
    // accented character re-serialised differently is enough to break it.
    expect(received[1].body).toBe(received[0].body);

    expect(received[1].headers["x-trajetto-signature"]).toBe(
      received[0].headers["x-trajetto-signature"],
    );

    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[1].body,
        header: received[1].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(true);
  });
});

describe("para onde um webhook NÃO sai", () => {
  it("recusa um endereço interno em vez de buscá-lo", async () => {
    // O ataque inteiro em três linhas: o cliente cadastra o endereço de
    // metadados da nuvem, nós buscamos, e o monitor devolve o corpo para ele.
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Metadados",
        url: "https://169.254.169.254/latest/meta-data/",
        secret: "whsec_teste",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await guardedDispatcher.processBatch();

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });

    expect(row.status).toBe("FAILED");

    // E nada foi buscado: o receptor local deste arquivo não recebeu nada, e
    // o corpo da resposta ficou vazio — que é o que impede o monitor de virar
    // um leitor da rede interna.
    expect(received).toHaveLength(0);
    expect(row.response_body ?? "").toBe("");

    // Permanente: repetir a varredura não pode virar uma sonda em laço.
    await guardedDispatcher.processBatch();

    expect(received).toHaveLength(0);
  });

  it("recusa localhost pelo nome", async () => {
    await prisma.webhookEndpoint.create({
      data: {
        name: "Interno",
        url: "https://localhost:9200/_cat/indices",
        secret: "whsec_teste",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await guardedDispatcher.processBatch();

    expect(received).toHaveLength(0);
  });

  it("não deixa o cliente sobrescrever a assinatura", async () => {
    const endpoint = await seedEndpoint({ topics: ["delivery.delivered"] });

    // O mapa é gravado direto, como uma linha anterior à regra do schema
    // estaria: a segunda tranca é a ordem do espalhamento no despachante.
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        headers: {
          "X-Trajetto-Signature": "t=1,v1=forjada",
          "X-Api-Key": "a-do-cliente",
        },
      },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: {},
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    // A nossa assinatura, não a dele — e ela verifica.
    expect(received[0].headers["x-trajetto-signature"]).not.toBe(
      "t=1,v1=forjada",
    );

    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        body: received[0].body,
        header: received[0].headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(true);

    // E o que é dele passa.
    expect(received[0].headers["x-api-key"]).toBe("a-do-cliente");
  });
});
