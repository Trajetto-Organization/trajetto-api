import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import auth from "@/config/auth";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * "Estou a caminho" (decision 6.4) through real HTTP and the real database:
 * the token, the tenant and module guards, the route lock and the unique
 * index on the submission id, and the customer notice pipeline all the way
 * to the (fake) WhatsApp provider.
 *
 * Every refusal is checked for what it did NOT write: a refused mark that
 * stamped the stop or queued a message is the bug this file exists for.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const CARRIER_A = "018fd000-0000-7000-8000-00000000000a";
const CARRIER_B = "018fd000-0000-7000-8000-00000000000b";
const CARRIER_NO_TEMPLATE = "018fd000-0000-7000-8000-00000000000c";
const CARRIER_NO_MODULE = "018fd000-0000-7000-8000-00000000000d";

const DRIVER_A = "018fd000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER_A = "018fd000-0000-7000-8000-0000000000d2";
const DRIVER_B = "018fd000-0000-7000-8000-0000000000d3";
const DRIVER_NO_TEMPLATE = "018fd000-0000-7000-8000-0000000000d4";
const DRIVER_NO_MODULE = "018fd000-0000-7000-8000-0000000000d5";

let driverTokenA: string;
let otherDriverTokenA: string;
let adminTokenA: string;
let driverTokenB: string;
let driverTokenNoTemplate: string;
let driverTokenNoModule: string;

const whatsapp = {
  sent: [] as Array<{ phoneNumber: string; message: string }>,
};

let cnpjSeq = 0;

async function seedBusiness(id: string, withDeliveries = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      fantasy_name: `Frota ${cnpjSeq}`,
      cep: "78000000",
      city: "Cuiabá",
      uf: "MT",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(33222111000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "65999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  if (withDeliveries) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module: "DELIVERIES", enabled: true },
    });
  }

  await prisma.shipper.create({
    data: { id: shipperOf(id), name: "Embarcador", businessId: id },
  });
}

const shipperOf = (businessId: string) =>
  `${businessId.slice(0, -4)}f00${businessId.slice(-1)}`;

async function seedDriver(businessId: string, id: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
      cep: "78000000",
      city: "Cuiabá",
      uf: "MT",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

async function seedUser(
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: driverId ?? null,
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
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

let routeCode = 100;

/**
 * A route with one stop per recipient. IN_PROGRESS by default, left an hour
 * ago, with its deliveries on the street — what a departure leaves behind.
 */
async function seedRoute(
  businessId: string,
  driverId: string,
  recipients: Array<{ name: string; telephone?: string | null }>,
  status:
    | "PLANNED"
    | "RELEASED"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "CANCELLED" = "IN_PROGRESS",
): Promise<{
  routeId: string;
  stops: Array<{ stopId: string; deliveryId: string }>;
}> {
  const deliveries = [];

  for (const recipient of recipients) {
    deliveries.push(
      await prisma.delivery.create({
        data: {
          businessId,
          shipperId: shipperOf(businessId),
          recipient_name: recipient.name,
          recipient_telephone: recipient.telephone ?? null,
          invoice_number: "12345",
          city: "Cuiabá",
          uf: "MT",
          street: "Rua das Entregas",
          status: status === "IN_PROGRESS" ? "IN_TRANSIT" : "PENDING",
          driverId,
        },
      }),
    );
  }

  routeCode += 1;

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      scheduled_date: new Date(),
      status,
      started_at:
        status === "IN_PROGRESS" ? new Date(Date.now() - 60 * 60 * 1000) : null,
      businessId,
      driverId,
      stops: {
        create: deliveries.map((delivery, index) => ({
          deliveryId: delivery.id,
          sequence: (index + 1) * 10,
        })),
      },
    },
    include: { stops: { orderBy: { sequence: "asc" } } },
  });

  return {
    routeId: route.id,
    stops: route.stops.map((stop) => ({
      stopId: stop.id,
      deliveryId: stop.deliveryId,
    })),
  };
}

function markUrl(stopId: string, routeId: string, businessId: string): string {
  return `/route/on-the-way/${stopId}/route/${routeId}/business/${businessId}`;
}

function mark(
  token: string,
  target: { stopId: string; routeId: string; businessId: string },
  body: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: markUrl(target.stopId, target.routeId, target.businessId),
    headers: { authorization: `Bearer ${token}` },
    payload: { client_submission_id: randomUUID(), ...body },
  });
}

async function stopRow(stopId: string) {
  return prisma.routeStop.findUniqueOrThrow({ where: { id: stopId } });
}

async function onTheWayEvents(deliveryId: string) {
  return prisma.deliveryEvent.findMany({
    where: { deliveryId, type: "ON_THE_WAY" },
    orderBy: { created_at: "asc" },
  });
}

async function outboxRows(deliveryId: string) {
  return prisma.domainOutboxEvent.findMany({
    where: { aggregateId: deliveryId, topic: "delivery.on_the_way" },
  });
}

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("external");
}

beforeAll(async () => {
  await seedBusiness(CARRIER_A);
  await seedBusiness(CARRIER_B);
  await seedBusiness(CARRIER_NO_TEMPLATE);
  await seedBusiness(CARRIER_NO_MODULE, false);

  await seedDriver(CARRIER_A, DRIVER_A);
  await seedDriver(CARRIER_A, OTHER_DRIVER_A);
  await seedDriver(CARRIER_B, DRIVER_B);
  await seedDriver(CARRIER_NO_TEMPLATE, DRIVER_NO_TEMPLATE);
  await seedDriver(CARRIER_NO_MODULE, DRIVER_NO_MODULE);

  driverTokenA = await seedUser(CARRIER_A, "BUSINESS_USER", DRIVER_A);
  otherDriverTokenA = await seedUser(
    CARRIER_A,
    "BUSINESS_USER",
    OTHER_DRIVER_A,
  );
  adminTokenA = await seedUser(CARRIER_A, "BUSINESS_ADMIN");
  driverTokenB = await seedUser(CARRIER_B, "BUSINESS_USER", DRIVER_B);
  driverTokenNoTemplate = await seedUser(
    CARRIER_NO_TEMPLATE,
    "BUSINESS_USER",
    DRIVER_NO_TEMPLATE,
  );
  driverTokenNoModule = await seedUser(
    CARRIER_NO_MODULE,
    "BUSINESS_USER",
    DRIVER_NO_MODULE,
  );

  // A has written "a caminho"; the other carrier wrote every other moment
  // but not this one.
  await prisma.deliveryMessageTemplate.create({
    data: {
      businessId: CARRIER_A,
      topic: "ON_THE_WAY",
      channel: "WHATSAPP",
      body: "{{destinatario}}, o motorista está a caminho. {{link}} Sair: {{link_descadastro}}",
    },
  });

  for (const topic of ["DISPATCHED", "DELIVERED", "FAILED"] as const) {
    await prisma.deliveryMessageTemplate.create({
      data: {
        businessId: CARRIER_NO_TEMPLATE,
        topic,
        channel: "WHATSAPP",
        body: `Momento ${topic}. {{link}} Sair: {{link_descadastro}}`,
      },
    });
  }

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: { phoneNumber: string; message: string }) => {
      whatsapp.sent.push(props);
      return { success: true, messageId: `wamid.${randomUUID()}` };
    },
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();

  // `drain()` is the only thing that runs the pipeline here. Each mark
  // publishes, and the publish wakes this process's worker 500 ms later: when
  // the mark and the checks took longer than that under load, the wake's
  // cycle was the one sending while the test looked (red: "expected [] ...
  // got +0"). Production has the same shape on an HTTP-only replica: the
  // request publishes, a worker's cycle delivers. Held for the whole file,
  // so no wake scheduled by one test fires into the next.
  vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);
}, APP_BOOT_TIMEOUT_MS);

beforeEach(() => {
  whatsapp.sent = [];
});

// The prisma environment gives this file a database of its own and drops it.
afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the driver marks a stop of their running route", () => {
  it("stamps the stop, records the event with the route and answers the instant", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Mercado Um", telephone: null },
    ]);
    const [{ stopId, deliveryId }] = stops;

    const response = await mark(
      driverTokenA,
      { stopId, routeId, businessId: CARRIER_A },
      { latitude: -15.6, longitude: -56.1 },
    );

    expect(response.statusCode).toBe(200);

    const { data } = response.json();

    expect(data).toMatchObject({ stopId, routeId, deliveryId });

    const stop = await stopRow(stopId);

    expect(stop.status).toBe("PENDING");
    expect(stop.on_the_way_at?.toISOString()).toBe(data.on_the_way_at);

    const [event] = await onTheWayEvents(deliveryId);

    expect(event).toMatchObject({
      routeId,
      businessId: CARRIER_A,
      actor: "DRIVER_APP",
      latitude: -15.6,
      longitude: -56.1,
    });
    expect(event.occurred_at?.toISOString()).toBe(data.on_the_way_at);
  });

  it("keeps the previous stop's instant when the driver turns to the next one", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Primeira" },
      { name: "Segunda" },
    ]);

    const first = await mark(driverTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });
    const second = await mark(driverTokenA, {
      ...stops[1],
      routeId,
      businessId: CARRIER_A,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const [a, b] = await Promise.all([
      stopRow(stops[0].stopId),
      stopRow(stops[1].stopId),
    ]);

    expect(a.on_the_way_at?.toISOString()).toBe(
      first.json().data.on_the_way_at,
    );
    expect(b.on_the_way_at!.getTime()).toBeGreaterThanOrEqual(
      a.on_the_way_at!.getTime(),
    );
  });

  it("dates a mark sent late by the tap, corrected by the phone's send stamp", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Offline" },
    ]);

    // The phone's clock runs 5 min fast: tap at its 10 min ago, sent at its now.
    const phoneNow = Date.now() + 5 * 60 * 1000;
    const tap = new Date(phoneNow - 10 * 60 * 1000).toISOString();

    const response = await app.inject({
      method: "POST",
      url: markUrl(stops[0].stopId, routeId, CARRIER_A),
      headers: {
        authorization: `Bearer ${driverTokenA}`,
        "x-client-sent-at": new Date(phoneNow).toISOString(),
      },
      payload: { client_submission_id: randomUUID(), occurred_at: tap },
    });

    expect(response.statusCode).toBe(200);

    const recorded = new Date(response.json().data.on_the_way_at).getTime();

    expect(Math.abs(recorded - (Date.now() - 10 * 60 * 1000))).toBeLessThan(
      10_000,
    );
  });
});

describe("a resend of the same submission", () => {
  it("answers the same result, writes one event, even racing the first send", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Reenvio" },
    ]);
    const target = { ...stops[0], routeId, businessId: CARRIER_A };
    const body = { client_submission_id: randomUUID() };

    const [one, two] = await Promise.all([
      mark(driverTokenA, target, body),
      mark(driverTokenA, target, body),
    ]);

    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(two.json().data).toEqual(one.json().data);

    // And again after the stop moved on: the resend is still the answer.
    await prisma.routeStop.update({
      where: { id: stops[0].stopId },
      data: { status: "ARRIVED", arrived_at: new Date() },
    });

    const late = await mark(driverTokenA, target, body);

    expect(late.statusCode).toBe(200);
    expect(late.json().data).toEqual(one.json().data);

    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(1);
  });

  it("refuses a key already used by another event with 409 SUBMISSION_ID_REUSED", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Chave" },
    ]);
    const key = randomUUID();

    await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId: stops[0].deliveryId,
        businessId: CARRIER_A,
        client_submission_id: key,
      },
    });

    const response = await mark(
      driverTokenA,
      { ...stops[0], routeId, businessId: CARRIER_A },
      { client_submission_id: key },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SUBMISSION_ID_REUSED");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
  });

  it("refuses a key another company already used, instead of a 500", async () => {
    const mine = await seedRoute(CARRIER_A, DRIVER_A, [{ name: "Minha" }]);
    const theirs = await seedRoute(CARRIER_B, DRIVER_B, [{ name: "Deles" }]);
    const key = randomUUID();

    const first = await mark(
      driverTokenB,
      { ...theirs.stops[0], routeId: theirs.routeId, businessId: CARRIER_B },
      { client_submission_id: key },
    );

    expect(first.statusCode).toBe(200);

    const response = await mark(
      driverTokenA,
      { ...mine.stops[0], routeId: mine.routeId, businessId: CARRIER_A },
      { client_submission_id: key },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SUBMISSION_ID_REUSED");
    expect((await stopRow(mine.stops[0].stopId)).on_the_way_at).toBeNull();
  });
});

describe("who may mark", () => {
  it("another driver of the same company: 404, as if the stop did not exist", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Alheia" },
    ]);

    const response = await mark(otherDriverTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("ROUTE_STOP_NOT_FOUND");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(0);
  });

  it("a driver of another company, naming their own company: 404", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Outra empresa" },
    ]);

    const response = await mark(driverTokenB, {
      ...stops[0],
      routeId,
      businessId: CARRIER_B,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("ROUTE_STOP_NOT_FOUND");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
  });

  it("a driver of another company, naming this one: refused by the tenant guard", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Guarda" },
    ]);

    const response = await mark(driverTokenB, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
  });

  it("the company's administrator: 403 PERMISSION_DENIED", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Painel" },
    ]);

    const response = await mark(adminTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(0);
  });

  it("a company without the Entregas module: 403 MODULE_NOT_ENABLED", async () => {
    const response = await mark(driverTokenNoModule, {
      stopId: randomUUID(),
      routeId: randomUUID(),
      businessId: CARRIER_NO_MODULE,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("no token: 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: markUrl(randomUUID(), randomUUID(), CARRIER_A),
      payload: { client_submission_id: randomUUID() },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("what state refuses", () => {
  it("a stop the driver already reached: 409 ROUTE_STOP_NOT_PENDING, nothing written", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Já cheguei", telephone: "65911110000" },
    ]);

    await prisma.routeStop.update({
      where: { id: stops[0].stopId },
      data: { status: "ARRIVED", arrived_at: new Date() },
    });

    const response = await mark(driverTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ROUTE_STOP_NOT_PENDING");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(0);
    expect(await outboxRows(stops[0].deliveryId)).toHaveLength(0);
  });

  it("a route that has not left: 409 ROUTE_NOT_IN_PROGRESS, nothing written", async () => {
    const { routeId, stops } = await seedRoute(
      CARRIER_A,
      DRIVER_A,
      [{ name: "Liberada", telephone: "65922220000" }],
      "RELEASED",
    );

    const response = await mark(driverTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ROUTE_NOT_IN_PROGRESS");
    expect((await stopRow(stops[0].stopId)).on_the_way_at).toBeNull();
    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(0);
    expect(await outboxRows(stops[0].deliveryId)).toHaveLength(0);
  });

  it("a malformed body: 400 VALIDATION_ERROR (latitude without longitude)", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Metade" },
    ]);

    const response = await mark(
      driverTokenA,
      { ...stops[0], routeId, businessId: CARRIER_A },
      { latitude: -15.6 },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("the message to the person waiting", () => {
  it("goes out under the company's ON_THE_WAY template, once per stop", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Padaria Central", telephone: "65933330000" },
    ]);
    const target = { ...stops[0], routeId, businessId: CARRIER_A };

    expect((await mark(driverTokenA, target)).statusCode).toBe(200);

    // The driver taps again (another submission): trail yes, message no.
    expect((await mark(driverTokenA, target)).statusCode).toBe(200);

    expect(await onTheWayEvents(stops[0].deliveryId)).toHaveLength(2);
    expect(await outboxRows(stops[0].deliveryId)).toHaveLength(1);

    await drain();

    const sent = whatsapp.sent.filter((entry) =>
      entry.phoneNumber.includes("65933330000"),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain(
      "Padaria Central, o motorista está a caminho.",
    );
  });

  it("does not go out when the company wrote no ON_THE_WAY template", async () => {
    const { routeId, stops } = await seedRoute(
      CARRIER_NO_TEMPLATE,
      DRIVER_NO_TEMPLATE,
      [{ name: "Sem modelo", telephone: "65944440000" }],
    );

    const response = await mark(driverTokenNoTemplate, {
      ...stops[0],
      routeId,
      businessId: CARRIER_NO_TEMPLATE,
    });

    expect(response.statusCode).toBe(200);

    const [row] = await outboxRows(stops[0].deliveryId);

    await drain();

    expect(
      whatsapp.sent.filter((entry) =>
        entry.phoneNumber.includes("65944440000"),
      ),
    ).toEqual([]);

    // Decided before any delivery row exists: no failure to count.
    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: row.id },
      }),
    ).toBe(0);
    expect(
      await prisma.externalRecipient.count({
        where: { deliveryId: stops[0].deliveryId },
      }),
    ).toBe(0);
  });

  it("is not even queued for a delivery with no contact", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Sem contato", telephone: null },
    ]);

    expect(
      (
        await mark(driverTokenA, {
          ...stops[0],
          routeId,
          businessId: CARRIER_A,
        })
      ).statusCode,
    ).toBe(200);

    expect(await outboxRows(stops[0].deliveryId)).toHaveLength(0);
  });

  it("does not go out after the delivery left the street before the send", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Já entregue", telephone: "65955550000" },
    ]);

    expect(
      (
        await mark(driverTokenA, {
          ...stops[0],
          routeId,
          businessId: CARRIER_A,
        })
      ).statusCode,
    ).toBe(200);

    // Delivered before the pipeline reached the queued message.
    await prisma.delivery.update({
      where: { id: stops[0].deliveryId },
      data: { status: "DELIVERED", delivered_at: new Date() },
    });

    await drain();

    expect(
      whatsapp.sent.filter((entry) =>
        entry.phoneNumber.includes("65955550000"),
      ),
    ).toEqual([]);
  });
});

describe("the message templates endpoints accept the new moment", () => {
  it("saves and lists an ON_THE_WAY template", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: `/delivery/message-template/${CARRIER_B}`,
      headers: {
        authorization: `Bearer ${await seedUser(CARRIER_B, "BUSINESS_ADMIN")}`,
      },
      payload: {
        topic: "ON_THE_WAY",
        channel: "EMAIL",
        subject: "Sua entrega está a caminho",
        body: "Olá {{destinatario}}, o motorista está a caminho. {{link}}",
      },
    });

    expect(saved.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: `/delivery/message-templates?businessId=${CARRIER_B}`,
      headers: {
        authorization: `Bearer ${await seedUser(CARRIER_B, "BUSINESS_ADMIN")}`,
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "ON_THE_WAY", channel: "EMAIL" }),
      ]),
    );
  });
});

describe("the operation's screens", () => {
  it("the tower's feed shows the mark with its route; the monitoring board, the stop's instant", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Torre" },
    ]);

    const marked = (
      await mark(driverTokenA, { ...stops[0], routeId, businessId: CARRIER_A })
    ).json().data;

    const tower = await app.inject({
      method: "GET",
      url: "/route/control-tower",
      headers: { authorization: `Bearer ${adminTokenA}` },
    });

    expect(tower.statusCode).toBe(200);

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    expect(tower.json().data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "delivery_event",
          type: "ON_THE_WAY",
          actor: "DRIVER_APP",
          deliveryId: stops[0].deliveryId,
          routeId,
          routeCode: route.code,
        }),
      ]),
    );

    const monitoring = await app.inject({
      method: "GET",
      url: "/route/monitoring?pageSize=50",
      headers: { authorization: `Bearer ${adminTokenA}` },
    });

    expect(monitoring.statusCode).toBe(200);

    const card = monitoring
      .json()
      .data.routes.find((entry: { id: string }) => entry.id === routeId);

    expect(new Date(card.stops[0].onTheWayAt).toISOString()).toBe(
      marked.on_the_way_at,
    );
    expect(card.progress.onTheWay).toBe(1);
  });
});

describe("the route detail", () => {
  it("serves each stop's on_the_way_at", async () => {
    const { routeId, stops } = await seedRoute(CARRIER_A, DRIVER_A, [
      { name: "Detalhe" },
    ]);

    const marked = await mark(driverTokenA, {
      ...stops[0],
      routeId,
      businessId: CARRIER_A,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/route/get-route/${routeId}/business/${CARRIER_A}`,
      headers: { authorization: `Bearer ${adminTokenA}` },
    });

    expect(detail.statusCode).toBe(200);

    const [stop] = detail.json().data.stops;

    expect(new Date(stop.on_the_way_at).toISOString()).toBe(
      marked.json().data.on_the_way_at,
    );
  });
});
