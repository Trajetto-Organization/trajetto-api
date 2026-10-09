import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The driver's side of the linked chat (decision 6.7), as the app uses it,
 * through real HTTP and the real database.
 *
 * The app now sends, from the driver's token: the delivery a message is about
 * (the API tags the route that carries it), or a whole route from its section
 * of the list. It drops a reference the API refuses and resends the same
 * words under the same submission id, and the delivery screen reads the
 * driver's own thread narrowed to that delivery. The panel side is covered by
 * chat-linked-broadcast-http.test.ts; this pins the driver side, including
 * another driver's and another company's ids.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018fe200-0000-7000-8000-00000000000b";

const JOAO = "018fe200-0000-7000-8000-0000000000d1";
const MARIA = "018fe200-0000-7000-8000-0000000000d2";
const FOREIGN = "018fe200-0000-7000-8000-0000000000d3";

const SHIPPER = "018fe200-0000-7000-8000-0000000000f1";

/** João's stop on his running route. */
const ON_RUNNING = "018fe200-0000-7000-8000-0000000000e1";

/** João's stop on the route released for later. */
const ON_RELEASED = "018fe200-0000-7000-8000-0000000000e2";

/** Maria's delivery, on Maria's route. */
const OF_MARIA = "018fe200-0000-7000-8000-0000000000e3";

let joaoToken = "";
let mariaToken = "";
let foreignDriverToken = "";

let runningRoute = "";
let releasedRoute = "";
let mariaRoute = "";
let foreignRoute = "";

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(21444555000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(businessId: string, id: string, name: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `${id.slice(-6)}cnh`,
      cpf: `${id.slice(-6)}cpf`,
      rg: `${id.slice(-6)}rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

/** A driver's app session: the access payload plus a live refresh family. */
async function seedDriverUser(businessId: string, driverId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Motorista ${id.slice(-4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_USER",
      businessId,
      driverId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

async function seedDelivery(id: string, driverId: string): Promise<void> {
  await prisma.delivery.create({
    data: {
      id,
      recipient_name: `Destinatário ${id.slice(-2)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      status: "IN_TRANSIT",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId,
    },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER_CARRIER);

  await seedDriver(CARRIER, JOAO, "João");
  await seedDriver(CARRIER, MARIA, "Maria");
  await seedDriver(OTHER_CARRIER, FOREIGN, "Estranho");

  joaoToken = await seedDriverUser(CARRIER, JOAO);
  mariaToken = await seedDriverUser(CARRIER, MARIA);
  foreignDriverToken = await seedDriverUser(OTHER_CARRIER, FOREIGN);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await seedDelivery(ON_RUNNING, JOAO);
  await seedDelivery(ON_RELEASED, JOAO);
  await seedDelivery(OF_MARIA, MARIA);

  runningRoute = (
    await prisma.route.create({
      data: {
        code: 21,
        name: "Zona Norte",
        scheduled_date: new Date("2026-09-29T00:00:00Z"),
        status: "IN_PROGRESS",
        started_at: new Date(),
        businessId: CARRIER,
        driverId: JOAO,
        stops: { create: [{ deliveryId: ON_RUNNING, sequence: 10 }] },
      },
    })
  ).id;

  releasedRoute = (
    await prisma.route.create({
      data: {
        code: 22,
        name: "Amanhã cedo",
        scheduled_date: new Date("2026-09-30T00:00:00Z"),
        status: "RELEASED",
        businessId: CARRIER,
        driverId: JOAO,
        stops: { create: [{ deliveryId: ON_RELEASED, sequence: 10 }] },
      },
    })
  ).id;

  mariaRoute = (
    await prisma.route.create({
      data: {
        code: 23,
        scheduled_date: new Date("2026-09-29T00:00:00Z"),
        status: "IN_PROGRESS",
        started_at: new Date(),
        businessId: CARRIER,
        driverId: MARIA,
        stops: { create: [{ deliveryId: OF_MARIA, sequence: 10 }] },
      },
    })
  ).id;

  foreignRoute = (
    await prisma.route.create({
      data: {
        code: 1,
        scheduled_date: new Date("2026-09-29T00:00:00Z"),
        businessId: OTHER_CARRIER,
        driverId: FOREIGN,
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/** What the app posts for the driver's own conversation. */
const send = (token: string, driverId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/chat/send-message",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      driverIds: [driverId],
      kind: "TEXT",
      clientSubmissionId: randomUUID(),
      ...payload,
    },
  });

const countBody = (body: string) => prisma.chatMessage.count({ where: { body } });

describe("POST /chat/send-message from the driver's app", () => {
  it("tags a message about a delivery with the route that carries it, not the running one", async () => {
    const response = await send(joaoToken, JOAO, {
      body: "Sobre a entrega de amanhã",
      deliveryId: ON_RELEASED,
    });

    expect(response.statusCode, response.body).toBe(201);

    const [message] = response.json().data;

    expect(message.delivery).toMatchObject({ id: ON_RELEASED });
    expect(message.route).toEqual({ id: releasedRoute, code: 22, name: "Amanhã cedo" });

    const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });

    expect(stored).toMatchObject({ deliveryId: ON_RELEASED, routeId: releasedRoute });
  });

  it("names the route of a message about a whole route", async () => {
    const response = await send(joaoToken, JOAO, {
      body: "Sobre a rota de amanhã",
      routeId: releasedRoute,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data[0]).toMatchObject({
      routeId: releasedRoute,
      deliveryId: null,
      route: { id: releasedRoute, code: 22 },
    });
  });

  it("answers another driver's route of the same company exactly like a missing one, and writes nothing", async () => {
    const ofMaria = await send(joaoToken, JOAO, {
      body: "Rota da Maria",
      routeId: mariaRoute,
    });
    const missing = await send(joaoToken, JOAO, {
      body: "Rota da Maria",
      routeId: randomUUID(),
    });

    // What the app relies on: refused for the reference alone (it resends
    // the words without it), with nothing written. The old 400
    // CHAT_ROUTE_OTHER_DRIVER told a driver the id exists (decision 4.4); the
    // driver side now answers it like a missing route, as deliveries do.
    expect(ofMaria.statusCode, ofMaria.body).toBe(404);
    expect(ofMaria.json()).toEqual({
      code: "CHAT_ROUTE_NOT_FOUND",
      message: "Rota não encontrada.",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(ofMaria.json());
    expect(await countBody("Rota da Maria")).toBe(0);
  });

  it("answers another company's route exactly like a missing one", async () => {
    const foreign = await send(joaoToken, JOAO, { body: "Rota alheia", routeId: foreignRoute });
    const missing = await send(joaoToken, JOAO, { body: "Rota alheia", routeId: randomUUID() });

    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toEqual({
      code: "CHAT_ROUTE_NOT_FOUND",
      message: "Rota não encontrada.",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
    expect(await countBody("Rota alheia")).toBe(0);
  });

  it("answers another driver's delivery exactly like a missing one", async () => {
    const ofMaria = await send(joaoToken, JOAO, { body: "Entrega alheia", deliveryId: OF_MARIA });
    const missing = await send(joaoToken, JOAO, { body: "Entrega alheia", deliveryId: randomUUID() });

    expect(ofMaria.statusCode, ofMaria.body).toBe(404);
    expect(ofMaria.json()).toEqual({
      code: "CHAT_DELIVERY_NOT_FOUND",
      message: "Entrega não encontrada.",
    });
    expect(missing.json()).toEqual(ofMaria.json());
    expect(await countBody("Entrega alheia")).toBe(0);
  });

  it("accepts the same submission, without the refused reference, as a new message", async () => {
    // What the app does after a stale reference: same words, same id, no chip.
    const clientSubmissionId = randomUUID();

    const refused = await send(joaoToken, JOAO, {
      body: "Cliente ausente, volto depois",
      deliveryId: OF_MARIA,
      clientSubmissionId,
    });

    expect(refused.statusCode).toBe(404);

    const resent = await send(joaoToken, JOAO, {
      body: "Cliente ausente, volto depois",
      clientSubmissionId,
    });

    expect(resent.statusCode, resent.body).toBe(201);
    expect(resent.json().outcomes[0].status).toBe("SENT");

    const rows = await prisma.chatMessage.findMany({
      where: { client_submission_id: clientSubmissionId },
    });

    // Said during João's running route, about no delivery.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deliveryId: null, routeId: runningRoute });
  });

  it("refuses a message for another driver's conversation", async () => {
    const response = await send(joaoToken, MARIA, { body: "Na conversa da Maria" });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("DRIVER_CHAT_OWN_THREAD");
    expect(await countBody("Na conversa da Maria")).toBe(0);
  });
});

describe("GET /chat/list-messages for a delivery, from the driver's app", () => {
  const listFor = (token: string, deliveryId: string) =>
    app.inject({
      method: "GET",
      url: `/chat/list-messages?limit=3&deliveryId=${deliveryId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("reads the driver's own thread narrowed to the delivery", async () => {
    await send(joaoToken, JOAO, { body: "Portão fechado", deliveryId: ON_RUNNING });
    await send(joaoToken, JOAO, { body: "Sem relação com a entrega" });

    const response = await listFor(joaoToken, ON_RUNNING);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.map((row: { body: string }) => row.body)).toEqual([
      "Portão fechado",
    ]);
  });

  it("shows nobody else's messages about the same delivery id", async () => {
    // Maria's thread holds nothing about João's delivery; the id alone opens
    // no other conversation.
    const maria = await listFor(mariaToken, ON_RUNNING);

    expect(maria.statusCode, maria.body).toBe(200);
    expect(maria.json().data).toEqual([]);

    // Another company's driver: his own (empty) conversation, never João's.
    const foreign = await listFor(foreignDriverToken, ON_RUNNING);

    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().data).toEqual([]);
    expect(foreign.body).not.toContain("Portão fechado");
  });
});

describe("GET /chat/list-messages for a route, from the driver's app", () => {
  // The route's section of the app's list previews what was said about it.
  const listFor = (token: string, routeId: string) =>
    app.inject({
      method: "GET",
      url: `/chat/list-messages?limit=3&routeId=${routeId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("reads the driver's own thread narrowed to the route, its stops' messages included", async () => {
    await send(joaoToken, JOAO, { body: "Doca 3 liberada", routeId: releasedRoute });
    await send(joaoToken, JOAO, { body: "Parada de amanhã sem acesso", deliveryId: ON_RELEASED });
    await send(joaoToken, JOAO, { body: "Parada de hoje sem acesso", deliveryId: ON_RUNNING });

    const response = await listFor(joaoToken, releasedRoute);

    expect(response.statusCode, response.body).toBe(200);

    const bodies = response.json().data.map((row: { body: string }) => row.body);

    // Newest first; the message about a stop of another route stays out.
    expect(bodies.slice(0, 2)).toEqual(["Parada de amanhã sem acesso", "Doca 3 liberada"]);
    expect(bodies).not.toContain("Parada de hoje sem acesso");
  });

  it("shows nobody else's messages about the same route id", async () => {
    const maria = await listFor(mariaToken, releasedRoute);

    expect(maria.statusCode, maria.body).toBe(200);
    expect(maria.json().data).toEqual([]);

    const foreign = await listFor(foreignDriverToken, releasedRoute);

    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().data).toEqual([]);
    expect(foreign.body).not.toContain("Doca 3 liberada");
  });
});
