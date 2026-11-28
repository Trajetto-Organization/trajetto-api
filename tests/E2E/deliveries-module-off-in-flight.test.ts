import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import {
  WebhookDispatchService,
  fanOutWebhookEvent,
  releaseHeldRowIfEndpointBack,
} from "@/shared/integration/webhook-dispatch-service";
import {
  ENDPOINT_PAUSED_REASON,
  REPLAY_WINDOW_DAYS,
  parkedUntil,
} from "@/shared/integration/webhook-dispatch-rules";
import { businessDateKey, dateOnlyFromKey } from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Switching Entregas off while a route is on the street (plan M3, D51:
 * "avisar no diálogo com as contagens e deixar terminar; webhooks pausados
 * junto"), through the real application.
 *
 * The route stayed IN_PROGRESS, the app hid the day and parked the proofs,
 * and nothing told anybody: the confirmation dialog counted deliveries but
 * not the routes in progress, and the webhook dispatcher kept draining the
 * company's queue to its ERP — the one integration the plan had just turned
 * off (the public API already answers 403 MODULE_NOT_ENABLED).
 *
 * Now the dialog counts the routes and the webhooks that will pause; nothing
 * is cancelled; the driver's day answers MODULE_NOT_ENABLED; and the
 * company's webhook rows are HELD (no call, no attempt, no failure) for the
 * replay window, going out as soon as the module is switched back on.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

const CARRIER = randomUUID();
const MASTER = randomUUID();
const DRIVER_USER = randomUUID();

const DAY_MS = 24 * 60 * 60 * 1000;

let masterToken = "";
let driverToken = "";

let routeId = "";
let deliveryId = "";
let endpointId = "";

let server: Server;
let baseUrl = "";
let received: string[] = [];

// The real dispatcher with a permissive destination check: the receiver is
// on loopback, which the production verifier refuses by design.
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

function switchDeliveries(enabled: boolean) {
  return app.inject({
    method: "PUT",
    url: `/business/entitlements/${CARRIER}`,
    headers: { authorization: `Bearer ${masterToken}` },
    payload: { module: "DELIVERIES", enabled },
  });
}

async function announce(index: number): Promise<void> {
  await fanOutWebhookEvent({
    topic: "delivery.delivered",
    businessId: CARRIER,
    payload: { index },
  });
}

function webhookRows() {
  return prisma.webhookDelivery.findMany({
    where: { businessId: CARRIER },
    orderBy: { created_at: "asc" },
  });
}

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
      corporate_reason: `Transportadora Desligada ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `desligada-${RUN}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: CARRIER, module: "FLEET", enabled: true },
      { businessId: CARRIER, module: "DELIVERIES", enabled: true },
    ],
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista na Rua",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: `9${String(Date.now()).slice(-10)}`,
      cpf: `${String(Date.now()).slice(-10)}3`,
      rg: "123456789",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        role: "MASTER",
        name: "Suporte",
        email: `master-${RUN}@exemplo.com.br`,
        password: "nao-usado",
      },
      {
        id: DRIVER_USER,
        role: "BUSINESS_USER",
        name: "Motorista na Rua",
        email: `motorista-${RUN}@exemplo.com.br`,
        password: "nao-usado",
        businessId: CARRIER,
        driverId: driver.id,
      },
    ],
  });

  const shipper = await prisma.shipper.create({
    data: { businessId: CARRIER, name: `Embarcador ${RUN}` },
  });

  routeId = (
    await prisma.route.create({
      data: {
        code: 1,
        name: "Rota na rua",
        businessId: CARRIER,
        driverId: driver.id,
        status: "IN_PROGRESS",
        scheduled_date: dateOnlyFromKey(
          businessDateKey(new Date(), "America/Sao_Paulo"),
        ),
        released_at: new Date(Date.now() - 60 * 60 * 1000),
        started_at: new Date(Date.now() - 30 * 60 * 1000),
      },
    })
  ).id;

  deliveryId = (
    await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: shipper.id,
        code: `NF-${RUN}`,
        recipient_name: "Mercado Central",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        status: "IN_TRANSIT",
        driverId: driver.id,
      },
    })
  ).id;

  await prisma.routeStop.create({
    data: { routeId, deliveryId, sequence: 1 },
  });

  endpointId = (
    await prisma.webhookEndpoint.create({
      data: {
        name: "ERP do cliente",
        url: `${baseUrl}/hook`,
        secret: "whsec_teste_do_modulo_desligado",
        topics: ["delivery.*"],
        businessId: CARRIER,
      },
    })
  ).id;

  masterToken = await tokenFor(MASTER);
  driverToken = await tokenFor(DRIVER_USER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

beforeEach(async () => {
  received = [];

  // Every case starts with the module on and an empty queue.
  await prisma.businessEntitlement.update({
    where: {
      businessId_module: { businessId: CARRIER, module: "DELIVERIES" },
    },
    data: { enabled: true },
  });

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  await app?.close();

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: CARRIER } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

describe("the confirmation dialog of switching Entregas off (M3)", () => {
  it("counts the routes on the street and the webhooks that will pause", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/entitlements/${CARRIER}/impact/DELIVERIES`,
      headers: { authorization: `Bearer ${masterToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    // Red before: "Entregas em rota" only — the route itself, the thing
    // that stays IN_PROGRESS, and the ERP that stops hearing were not there.
    expect(response.json().data.inFlight).toEqual(
      expect.arrayContaining([
        { label: "Rotas em andamento", count: 1 },
        { label: "Entregas em rota", count: 1 },
        { label: "Webhooks ativos (pausados até religar)", count: 1 },
      ]),
    );
  });
});

describe("Entregas switched off with a route on the street (M3, D51)", () => {
  it("leaves the route and its delivery as they were, and closes the driver's day", async () => {
    expect((await switchDeliveries(false)).statusCode).toBe(200);

    // Nothing is cancelled or finished by the switch: the route resumes
    // when the module comes back.
    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(route.status).toBe("IN_PROGRESS");
    expect(delivery.status).toBe("IN_TRANSIT");

    // The app reads this code to hide the day and keep the proofs queued.
    const day = await app.inject({
      method: "GET",
      url: `/delivery/my-deliveries/${CARRIER}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });

    expect(day.statusCode, day.body).toBe(403);
    expect(day.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("holds the company's webhooks while it is off, and sends them once it is back", async () => {
    await announce(1);

    expect((await switchDeliveries(false)).statusCode).toBe(200);

    // Queued before the switch, and one more fact while it is off.
    await announce(2);

    await dispatcher.processBatch();

    // Red before: the dispatcher kept posting to the company's ERP.
    expect(received, "o webhook saiu com o módulo desligado").toHaveLength(0);

    const held = await webhookRows();

    expect(held).toHaveLength(2);

    for (const row of held) {
      // Held: not an attempt, not a failure, out of the claim's way until
      // the replay window ends.
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.availableAt.getTime()).toBeGreaterThan(
        Date.now() + (REPLAY_WINDOW_DAYS - 1) * DAY_MS,
      );
    }

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });

    expect(endpoint.consecutive_failures).toBe(0);
    expect(endpoint.disabled_at).toBeNull();

    expect((await switchDeliveries(true)).statusCode).toBe(200);

    await dispatcher.processBatch();

    expect(received).toHaveLength(2);
    expect((await webhookRows()).map((row) => row.status)).toEqual([
      "DELIVERED",
      "DELIVERED",
    ]);
  });

  it("releases a row parked while the switch was coming back on", async () => {
    // The worker read the module as off, then the switch committed and its
    // release ran before this row was written held: the re-check after the
    // write is what sends it.
    const row = await prisma.webhookDelivery.create({
      data: {
        endpointId,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: { id: randomUUID() },
        signature: "",
        availableAt: parkedUntil(new Date()),
        lastError: ENDPOINT_PAUSED_REASON,
      },
    });

    await prisma.businessEntitlement.update({
      where: {
        businessId_module: { businessId: CARRIER, module: "DELIVERIES" },
      },
      data: { enabled: false },
    });

    await releaseHeldRowIfEndpointBack(row.id, endpointId);

    expect(
      (
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).availableAt.getTime(),
      "liberado com o módulo ainda desligado",
    ).toBeGreaterThan(Date.now() + DAY_MS);

    await prisma.businessEntitlement.update({
      where: {
        businessId_module: { businessId: CARRIER, module: "DELIVERIES" },
      },
      data: { enabled: true },
    });

    await releaseHeldRowIfEndpointBack(row.id, endpointId);

    const released = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(released.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(released.lastError).toBeNull();
  });

  it("sends what was held when the master saves the module on again", async () => {
    // A switch-on whose release did not run (the request failed after the
    // commit): the module reads on, the rows are still held. Saving it on
    // again is the retry, as saving an endpoint again is for an endpoint.
    await prisma.webhookDelivery.create({
      data: {
        endpointId,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: { id: randomUUID() },
        signature: "",
        availableAt: parkedUntil(new Date()),
        lastError: ENDPOINT_PAUSED_REASON,
      },
    });

    expect((await switchDeliveries(true)).statusCode).toBe(200);

    await dispatcher.processBatch();

    expect(received).toHaveLength(1);
  });

  it("says so in the switch's documentation", () => {
    const document = app.swagger() as unknown as {
      paths: Record<string, Record<string, { description?: string }>>;
    };

    expect(
      document.paths["/business/entitlements/{businessId}"].put.description,
    ).toMatch(/webhooks da empresa ficam pausados/);
  });
});
