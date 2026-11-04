import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { WebhookDispatchService } from "@/shared/integration/webhook-dispatch-service";
import { verifyWebhookSignature } from "@/shared/integration/webhook-signature";
import {
  ALL_TOPICS,
  isKnownSubscription,
} from "@/shared/integration/webhook-catalogue";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * "Enviar teste" (plan of 02/11/2026, L1, decision D48): before this, the
 * first real event was a customer's first test of their receiver.
 *
 * Over HTTP and through the real dispatcher, against a real receiver: the
 * ping must be signed and sent exactly like an event, recorded in
 * webhook_delivery, reach ONLY the endpoint chosen — never one subscribed by
 * a wildcard, since `ping` is outside the catalogue — and carry the tenant,
 * module, role and rate checks every integration write carries.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe310-0000-7000-8000-00000000000a";
const OTHER = "018fe310-0000-7000-8000-00000000000b";
const FLEET = "018fe310-0000-7000-8000-00000000000c";

const ADMIN = "018fe310-0000-7000-8000-0000000000a1";
const SPAMMER = "018fe310-0000-7000-8000-0000000000a2";
const OTHER_ADMIN = "018fe310-0000-7000-8000-0000000000a3";
const FLEET_ADMIN = "018fe310-0000-7000-8000-0000000000a4";
const CLERK = "018fe310-0000-7000-8000-0000000000a5";

const SECRET = "whsec_segredo_do_teste_de_envio";

const tokens: Record<string, string> = {};

const endpoints = {
  chosen: "",
  wildcard: "",
  paused: "",
  switchedOff: "",
  otherCompany: "",
  fleet: "",
};

interface Received {
  body: string;
  headers: Record<string, string | undefined>;
}

let server: Server;
let baseUrl = "";
const received: Received[] = [];

/** Permissive destinations: the receiver runs on 127.0.0.1. */
const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

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
    { subject: userId, expiresIn: "1h" },
  );
}

async function seedBusiness(
  id: string,
  modules: Array<"DELIVERIES" | "FLEET">,
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ping-${randomUUID()}@exemplo.com.br`,
    },
  });

  for (const module of modules) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module, enabled: true },
    });
  }
}

async function seedUser(
  id: string,
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      name: `Pessoa ${id.slice(-2)}`,
      email: `pessoa-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role,
      businessId,
    },
  });

  tokens[id] = await tokenFor(id);
}

async function seedEndpoint(
  businessId: string,
  topics: string[],
  extra: { is_active?: boolean; disabled_at?: Date } = {},
): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `Receptor ${randomUUID().slice(0, 4)}`,
      url: `${baseUrl}/hook`,
      secret: SECRET,
      topics,
      businessId,
      ...extra,
    },
  });

  return endpoint.id;
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
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await seedBusiness(CARRIER, ["DELIVERIES"]);
  await seedBusiness(OTHER, ["DELIVERIES"]);
  await seedBusiness(FLEET, ["FLEET"]);

  await seedUser(ADMIN, CARRIER, "BUSINESS_ADMIN");
  await seedUser(SPAMMER, CARRIER, "BUSINESS_ADMIN");
  await seedUser(OTHER_ADMIN, OTHER, "BUSINESS_ADMIN");
  await seedUser(FLEET_ADMIN, FLEET, "BUSINESS_ADMIN");
  // No profile: no integration_manage at all.
  await seedUser(CLERK, CARRIER, "BUSINESS_USER");

  endpoints.chosen = await seedEndpoint(CARRIER, ["delivery.created"]);
  // Everything a subscription can say: every wildcard of the catalogue.
  endpoints.wildcard = await seedEndpoint(CARRIER, [
    "route.*",
    "delivery.*",
    "occurrence.*",
    "proof.*",
  ]);
  endpoints.paused = await seedEndpoint(CARRIER, ["delivery.*"], {
    is_active: false,
  });
  endpoints.switchedOff = await seedEndpoint(CARRIER, ["delivery.*"], {
    disabled_at: new Date(),
  });
  endpoints.otherCompany = await seedEndpoint(OTHER, ["delivery.*"]);
  endpoints.fleet = await seedEndpoint(FLEET, ["delivery.*"]);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  const companies = [CARRIER, OTHER, FLEET];

  await prisma.activity.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.webhookDelivery.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.webhookEndpoint.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: Object.keys(tokens) } },
  });
  await prisma.user.deleteMany({ where: { id: { in: Object.keys(tokens) } } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.business.deleteMany({ where: { id: { in: companies } } });

  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

function sendTest(userId: string, endpointId: string, businessId: string) {
  return app.inject({
    method: "POST",
    url: `/integrations/webhook-endpoint/${endpointId}/business/${businessId}/test`,
    headers: { authorization: `Bearer ${tokens[userId]}` },
  });
}

describe("sending a test to an endpoint", () => {
  it("queues one signed ping for the chosen endpoint, and the receiver verifies it", async () => {
    const response = await sendTest(ADMIN, endpoints.chosen, CARRIER);

    expect(response.statusCode, response.body).toBe(200);

    const { data } = response.json() as {
      data: { id: string; event_id: string };
    };

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: data.id },
    });

    // Recorded like any event: the monitor shows it, with its answer.
    expect(row).toMatchObject({
      endpointId: endpoints.chosen,
      businessId: CARRIER,
      topic: "ping",
      sourceEventId: data.event_id,
      status: "PENDING",
    });

    // Only the chosen endpoint: the one subscribed to every wildcard got no
    // row at all.
    expect(
      await prisma.webhookDelivery.count({
        where: { endpointId: endpoints.wildcard },
      }),
    ).toBe(0);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const [arrived] = received;

    // The acceptance criterion: the customer's receiver validates it with
    // the same check our documentation tells them to implement.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: arrived.body,
        header: arrived.headers["x-trajetto-signature"] ?? "",
      }),
    ).toBe(true);

    expect(arrived.headers["x-trajetto-topic"]).toBe("ping");
    expect(arrived.headers["x-trajetto-event-id"]).toBe(data.event_id);

    const body = JSON.parse(arrived.body);

    expect(body).toMatchObject({
      id: data.event_id,
      topic: "ping",
      data: { endpoint_id: endpoints.chosen },
    });
    expect(typeof body.sequence).toBe("number");
    expect(typeof body.created_at).toBe("string");

    expect(
      (
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: data.id },
        })
      ).status,
    ).toBe("DELIVERED");
  });

  it("is outside the catalogue, so no subscription can ever name or match it", async () => {
    expect(ALL_TOPICS as string[]).not.toContain("ping");
    expect(isKnownSubscription("ping")).toBe(false);

    const refused = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens[ADMIN]}` },
      payload: {
        name: "Só testes",
        url: "https://erp.exemplo.com.br/ping",
        topics: ["ping"],
      },
    });

    expect(refused.statusCode).toBe(400);
  });

  it("refuses a paused or switched-off endpoint with the reason, queueing nothing", async () => {
    for (const [endpointId, code] of [
      [endpoints.paused, "WEBHOOK_ENDPOINT_PAUSED"],
      [endpoints.switchedOff, "WEBHOOK_ENDPOINT_DISABLED"],
    ] as const) {
      const response = await sendTest(ADMIN, endpointId, CARRIER);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe(code);
      expect(
        await prisma.webhookDelivery.count({ where: { endpointId } }),
      ).toBe(0);
    }
  });

  it("answers another company's endpoint as missing, and another company in the path with the tenant refusal", async () => {
    const foreignEndpoint = await sendTest(
      ADMIN,
      endpoints.otherCompany,
      CARRIER,
    );

    expect(foreignEndpoint.statusCode).toBe(404);
    expect(foreignEndpoint.json().code).toBe("WEBHOOK_ENDPOINT_NOT_FOUND");

    const foreignPath = await sendTest(ADMIN, endpoints.otherCompany, OTHER);

    expect(foreignPath.statusCode).toBe(403);
    expect(foreignPath.json().code).toBe("TENANT_ACCESS_DENIED");

    expect(
      await prisma.webhookDelivery.count({
        where: { endpointId: endpoints.otherCompany },
      }),
    ).toBe(0);
  });

  it("refuses a company without Entregas and a person without integration_manage", async () => {
    const fleet = await sendTest(FLEET_ADMIN, endpoints.fleet, FLEET);

    expect(fleet.statusCode).toBe(403);
    expect(fleet.json().code).toBe("MODULE_NOT_ENABLED");

    const clerk = await sendTest(CLERK, endpoints.chosen, CARRIER);

    expect(clerk.statusCode).toBe(403);
  });

  it("allows ten tests a minute and answers 429 past that", async () => {
    const statuses: number[] = [];

    for (let call = 0; call < 11; call += 1) {
      statuses.push(
        (await sendTest(SPAMMER, endpoints.chosen, CARRIER)).statusCode,
      );
    }

    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });
});
