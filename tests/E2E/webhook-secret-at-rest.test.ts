import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";
import { verifyWebhookSignature } from "@/shared/integration/webhook-signature";
import {
  openHeaders,
  openSecret,
  sealSecret,
} from "@/shared/integration/secret-box";

/**
 * A webhook endpoint's credentials, as the database holds them and as the
 * receiver meets them.
 *
 * The signing secret and the customer's own headers were stored in clear: a
 * leaked dump forged webhooks to every customer and called their gateways
 * with their credentials. And the only way to change a leaked secret was to
 * delete the endpoint, which cascades its whole delivery history.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdc70-0000-7000-8000-00000000000a";
const ADMIN = "018fdc70-0000-7000-8000-0000000000a1";

const HOUR_MS = 60 * 60 * 1000;

let token = "";

let server: Server;
let baseUrl = "";
const received: Array<{ body: string; headers: Record<string, string | undefined> }> = [];

const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

async function tokenFor(userId: string, businessId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + HOUR_MS),
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
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers as Record<string, string | undefined>,
      });

      response.writeHead(200);
      response.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Segredos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `segredos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora",
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
  await app?.close();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let endpointId = "";
let firstSecret = "";
let secondSecret = "";

async function deliverOne(): Promise<(typeof received)[number]> {
  received.length = 0;

  await fanOutWebhookEvent({
    topic: "delivery.created",
    businessId: CARRIER,
    payload: { delivery_id: randomUUID() },
  });

  await dispatcher.processBatch();

  expect(received).toHaveLength(1);

  return received[0];
}

describe("an endpoint's credentials at rest", () => {
  it("are sealed in the database, and the secret is still shown once", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "ERP",
        url: "https://erp.exemplo.com.br/webhooks",
        topics: ["delivery.created"],
        headers: { Authorization: "Bearer credencial-do-gateway" },
        is_active: true,
      },
    });

    expect(response.statusCode, response.body).toBe(201);

    const { data } = JSON.parse(response.body);

    endpointId = data.id;
    firstSecret = data.secret;

    expect(firstSecret).toMatch(/^whsec_/);

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(stored.secret).not.toBe(firstSecret);
    expect(stored.secret).not.toContain(firstSecret);
    expect(openSecret(stored.secret)).toBe(firstSecret);

    expect(JSON.stringify(stored.headers)).not.toContain("credencial-do-gateway");
    expect(openHeaders(stored.headers)).toEqual({
      Authorization: "Bearer credencial-do-gateway",
    });
  });

  it("stay sealed through an edit, which keeps the headers it did not send", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "ERP (editado)",
        url: "https://erp.exemplo.com.br/webhooks",
        topics: ["delivery.created"],
        is_active: true,
      },
    });

    expect(response.statusCode, response.body).toBe(200);

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(JSON.stringify(stored.headers)).not.toContain("credencial-do-gateway");
    expect(openHeaders(stored.headers)).toEqual({
      Authorization: "Bearer credencial-do-gateway",
    });
  });

  it("reach the receiver in clear: the signature verifies and the header arrives", async () => {
    // Pointed at the local receiver behind the API's back: registration only
    // accepts https.
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { url: `${baseUrl}/hook` },
    });

    const call = await deliverOne();

    expect(call.headers.authorization).toBe("Bearer credencial-do-gateway");

    expect(
      verifyWebhookSignature({
        secret: firstSecret,
        body: call.body,
        header: call.headers["x-trajetto-signature"]!,
      }),
    ).toBe(true);
  });
});

describe("rotating the secret", () => {
  it("shows the new secret once and keeps the old one for a grace period", async () => {
    const before = Date.now();

    const response = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${endpointId}/business/${CARRIER}/rotate-secret`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const { data } = JSON.parse(response.body);

    secondSecret = data.secret;

    expect(data.id).toBe(endpointId);
    expect(secondSecret).toMatch(/^whsec_/);
    expect(secondSecret).not.toBe(firstSecret);

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(openSecret(stored.secret)).toBe(secondSecret);
    expect(openSecret(stored.previous_secret!)).toBe(firstSecret);
    expect(stored.previous_secret).not.toContain(firstSecret);

    const expiresIn = stored.previous_secret_expires_at!.getTime() - before;

    expect(expiresIn).toBeGreaterThan(23 * HOUR_MS);
    expect(expiresIn).toBeLessThan(25 * HOUR_MS);
  });

  it("signs with both until then, so the receiver switches when it is ready", async () => {
    const call = await deliverOne();
    const header = call.headers["x-trajetto-signature"]!;

    for (const secret of [firstSecret, secondSecret]) {
      expect(verifyWebhookSignature({ secret, body: call.body, header })).toBe(
        true,
      );
    }
  });

  it("signs with the new one alone once the grace period is over", async () => {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { previous_secret_expires_at: new Date(Date.now() - 1_000) },
    });

    const call = await deliverOne();
    const header = call.headers["x-trajetto-signature"]!;

    expect(header.match(/v1=/g)).toHaveLength(1);

    expect(
      verifyWebhookSignature({ secret: secondSecret, body: call.body, header }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({ secret: firstSecret, body: call.body, header }),
    ).toBe(false);
  });

  it("never costs the business write when a secret cannot be opened", async () => {
    // Sealed under a key this process does not have: WEBHOOK_SECRETS_KEY
    // lost or changed after sealing.
    const foreign = sealSecret("whsec_de_outra_chave", randomBytes(32));

    const unreadable = await prisma.webhookEndpoint.create({
      data: {
        name: "Selado com outra chave",
        url: `${baseUrl}/hook`,
        secret: foreign,
        topics: ["route.released"],
        businessId: CARRIER,
      },
    });

    // The fan-out rides the business write's transaction: it must not throw.
    const queued = await prisma.$transaction((tx) =>
      fanOutWebhookEvent(
        {
          topic: "route.released",
          businessId: CARRIER,
          payload: { route_id: randomUUID() },
        },
        tx,
      ),
    );

    expect(queued).toBe(1);

    received.length = 0;
    await dispatcher.processBatch();

    // Nothing unverifiable left, and the customer's endpoint is not blamed
    // for our key.
    expect(received).toHaveLength(0);

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: unreadable.id },
    });

    expect(endpoint.consecutive_failures).toBe(0);
    expect(endpoint.disabled_at).toBeNull();

    await prisma.webhookDelivery.deleteMany({ where: { endpointId: unreadable.id } });
    await prisma.webhookEndpoint.delete({ where: { id: unreadable.id } });
  });

  it("recovers an endpoint whose secret can no longer be opened", async () => {
    // The key the secret was sealed with is gone. Rotating is the way out,
    // so it must not need to open the old value — and the send must not
    // fail over a second signature it cannot make.
    const lost = await prisma.webhookEndpoint.create({
      data: {
        name: "Chave perdida",
        url: `${baseUrl}/hook`,
        secret: sealSecret("whsec_irrecuperavel", randomBytes(32)),
        topics: ["route.cancelled"],
        businessId: CARRIER,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${lost.id}/business/${CARRIER}/rotate-secret`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const fresh = JSON.parse(response.body).data.secret as string;

    received.length = 0;

    await fanOutWebhookEvent({
      topic: "route.cancelled",
      businessId: CARRIER,
      payload: { route_id: randomUUID() },
    });

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);

    const header = received[0].headers["x-trajetto-signature"]!;

    expect(
      verifyWebhookSignature({ secret: fresh, body: received[0].body, header }),
    ).toBe(true);

    await prisma.webhookDelivery.deleteMany({ where: { endpointId: lost.id } });
    await prisma.webhookEndpoint.delete({ where: { id: lost.id } });
  });

  it("is refused for another company's endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/integrations/webhook-endpoint/${randomUUID()}/business/${CARRIER}/rotate-secret`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
  });
});
