import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";
import { ProofDocumentRepository } from "@/modules/delivery/repositories/proof-document-repository";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The time of the fact, through the real routes and the real database
 * (MOB-08).
 *
 * The app queues a driver's actions in dead zones and sends them hours later.
 * The body now carries `occurred_at` (the tap, by the phone's clock) and the
 * request `X-Client-Sent-At` (the send, by the same clock). The phone in these
 * tests runs two hours FAST, as a phone set by hand does: only the difference
 * between the two stamps may reach the database, anchored on the server's
 * clock. And a build that sends neither keeps exactly today's behaviour.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fd960-0000-7000-8000-00000000000a";

const HOUR = 60 * 60 * 1000;

// The phone's clock error. Positive: the phone is ahead of the server.
const PHONE_AHEAD_MS = 2 * HOUR;

const storedKeys: string[] = [];

let shipperId = "";
let occurrenceTypeId = "";

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${BUSINESS}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryFor(
  status: "PENDING" | "IN_TRANSIT",
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: BUSINESS,
      shipperId,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
      status,
    },
  });

  return delivery.id;
}

/**
 * What the app sends for an action tapped `agoMs` before it is sent, by a
 * phone whose clock is PHONE_AHEAD_MS fast.
 */
function stampedOffline(agoMs: number): {
  occurred_at: string;
  headers: Record<string, string>;
} {
  const phoneNow = Date.now() + PHONE_AHEAD_MS;

  return {
    occurred_at: new Date(phoneNow - agoMs).toISOString(),
    headers: { "x-client-sent-at": new Date(phoneNow).toISOString() },
  };
}

function post(
  url: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    ...(body !== undefined && { payload: body }),
  });
}

const deliveryUrl = (action: string, deliveryId: string) =>
  `/delivery/${action}/${deliveryId}/business/${BUSINESS}`;

/** The server's "now minus agoMs", bounded by the request's own duration. */
function expectAgo(
  actual: Date | null | undefined,
  agoMs: number,
  window: { before: number; after: number },
) {
  expect(actual).toBeInstanceOf(Date);

  const at = (actual as Date).getTime();

  // One second of slack for the phone-side stamps being taken a hair before
  // the request leaves.
  expect(at).toBeGreaterThanOrEqual(window.before - agoMs - 1_000);
  expect(at).toBeLessThanOrEqual(window.after - agoMs + 1_000);
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000272",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: BUSINESS },
    })
  ).id;

  occurrenceTypeId = (
    await prisma.occurrenceType.create({
      data: {
        name: "Portaria fechada",
        blocks_delivery: false,
        businessId: BUSINESS,
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("an arrival sent three hours late by a phone two hours fast", () => {
  it("is recorded three hours ago by the server's clock", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");
    const key = randomUUID();
    const { occurred_at, headers } = stampedOffline(3 * HOUR);

    const before = Date.now();
    const response = await post(
      deliveryUrl("arrival", deliveryId),
      { client_submission_id: key, latitude: -23.55, longitude: -46.63, occurred_at },
      headers,
    );
    const after = Date.now();

    expect(response.statusCode, response.body).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { client_submission_id: key },
    });

    expectAgo(event.occurred_at, 3 * HOUR, { before, after });

    // The receipt stays the receipt: it is what incremental readers page by.
    expect(event.created_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });
});

describe("a proof sent three hours late by a phone two hours fast", () => {
  let deliveryId = "";
  let key = "";
  let window = { before: 0, after: 0 };

  beforeAll(async () => {
    deliveryId = await deliveryFor("IN_TRANSIT");
    key = randomUUID();

    const { occurred_at, headers } = stampedOffline(3 * HOUR);

    window.before = Date.now();
    const response = await post(
      deliveryUrl("proof", deliveryId),
      {
        client_submission_id: key,
        received_by: "Maria Souza",
        photo: await storedPhoto(),
        occurred_at,
      },
      headers,
    );
    window.after = Date.now();

    expect(response.statusCode, response.body).toBe(201);
  });

  it("delivers the delivery at the moment of the proof", async () => {
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.status).toBe("DELIVERED");
    expectAgo(delivery.delivered_at, 3 * HOUR, window);

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { client_submission_id: key },
    });

    expect(proof.occurred_at?.getTime()).toBe(delivery.delivered_at?.getTime());
  });

  it("tells the person waiting, the receipt and the integrations the same hour", async () => {
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const provenAt = delivery.delivered_at!.getTime();

    // Customer tracking page.
    const token = randomBytes(32).toString("hex");
    await prisma.externalRecipient.create({
      data: { deliveryId, businessId: BUSINESS, access_token: token },
    });

    const tracking = await new ExternalRecipientRepository().findByToken(token);
    const shown = tracking?.events.find((event) => event.type === "PROOF");
    expect(new Date(shown!.created_at).getTime()).toBe(provenAt);

    // The printed receipt.
    const source = await new ProofDocumentRepository().loadSource(
      deliveryId,
      BUSINESS,
    );
    expect(new Date(source!.proof!.created_at).getTime()).toBe(provenAt);

    // The integration event feed.
    const feed = await new IntegrationRepository().listEvents({
      businessId: BUSINESS,
      limit: 100,
    });
    const published = feed.data.find(
      (event) =>
        event.delivery.id === deliveryId && event.topic === "proof.registered",
    );
    expect(new Date(published!.occurred_at).getTime()).toBe(provenAt);
  });
});

describe("an occurrence sent an hour late by a phone two hours fast", () => {
  it("is recorded an hour ago by the server's clock", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");
    const key = randomUUID();
    const { occurred_at, headers } = stampedOffline(HOUR);

    const before = Date.now();
    const response = await post(
      deliveryUrl("report-occurrence", deliveryId),
      { client_submission_id: key, occurrenceTypeId, occurred_at },
      headers,
    );
    const after = Date.now();

    expect(response.statusCode, response.body).toBe(201);

    const occurrence = await prisma.deliveryOccurrence.findFirstOrThrow({
      where: { client_submission_id: key },
    });

    expectAgo(occurrence.occurred_at, HOUR, { before, after });
  });
});

describe("a build that sends no time", () => {
  it("keeps the receipt as the time of the fact", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");
    const key = randomUUID();

    const before = Date.now();
    const response = await post(deliveryUrl("proof", deliveryId), {
      client_submission_id: key,
      photo: await storedPhoto(),
    });

    expect(response.statusCode, response.body).toBe(201);

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { client_submission_id: key },
    });
    expect(proof.occurred_at).toBeNull();

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.delivered_at!.getTime()).toBeGreaterThanOrEqual(
      before - 1_000,
    );
  });

  it("is not refused over an unreadable time either", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");
    const key = randomUUID();

    const response = await post(
      deliveryUrl("arrival", deliveryId),
      {
        client_submission_id: key,
        latitude: -23.55,
        longitude: -46.63,
        occurred_at: "ontem à tarde",
      },
      { "x-client-sent-at": "agora" },
    );

    expect(response.statusCode, response.body).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { client_submission_id: key },
    });
    expect(event.occurred_at).toBeNull();
  });
});

describe("the legacy departure replayed after a new route was released", () => {
  let routeId = "";

  beforeAll(async () => {
    const deliveryId = await deliveryFor("PENDING");

    const route = await prisma.route.create({
      data: {
        code: 1,
        status: "RELEASED",
        scheduled_date: new Date(),
        businessId: BUSINESS,
        driverId: seed.driverId,
        vehicleId: seed.vehicleId,
      },
    });

    await prisma.routeStop.create({
      data: { routeId: route.id, deliveryId, sequence: 10 },
    });

    routeId = route.id;
  });

  it("does not start a route released after the tap", async () => {
    const { occurred_at, headers } = stampedOffline(20 * HOUR);

    const response = await post(
      `/delivery/start-route/${BUSINESS}`,
      { occurred_at },
      headers,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ started: 0 });

    const route = await prisma.route.findUniqueOrThrow({ where: { id: routeId } });
    expect(route.status).toBe("RELEASED");
  });

  it("answers a build that posts no body at all without starting it either", async () => {
    // IDEMP-17: the legacy endpoint never starts a route — the app calls it
    // only when it shows none, and a route leaves through its own endpoint.
    // Still a 200, so no build's queued tap turns into a failure.
    const response = await post(`/delivery/start-route/${BUSINESS}`, undefined);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ started: 0 });

    const route = await prisma.route.findUniqueOrThrow({ where: { id: routeId } });
    expect(route.status).toBe("RELEASED");
  });
});

describe("the status the integrations read after a driver's outcome", () => {
  /**
   * The document events say "o status da entrega depois do evento". The
   * proof and the occurrence read the delivery BEFORE the event, and a real
   * database hands back that snapshot: proof.registered said IN_TRANSIT for a
   * delivery the same transaction had just made DELIVERED. A blocking
   * occurrence said IN_TRANSIT for a FAILED delivery, and announced no
   * delivery.failed at all.
   */
  let blockingTypeId = "";

  /** The `data` of the webhook rows written for this delivery and topic. */
  async function webhookData(deliveryId: string, topic: string) {
    const rows = await prisma.webhookDelivery.findMany({
      where: { businessId: BUSINESS, topic },
    });

    return rows
      .map((row) => (row.payload as { data: Record<string, unknown> }).data)
      .filter((data) => data.delivery_id === deliveryId);
  }

  beforeAll(async () => {
    await prisma.webhookEndpoint.create({
      data: {
        name: "ERP do embarcador",
        url: "https://erp.example.invalid/hook",
        secret: "segredo-de-teste-com-tamanho-suficiente",
        topics: ["proof.registered", "occurrence.reported", "delivery.failed"],
        businessId: BUSINESS,
      },
    });

    blockingTypeId = (
      await prisma.occurrenceType.create({
        data: {
          name: "Cliente ausente",
          blocks_delivery: true,
          businessId: BUSINESS,
        },
      })
    ).id;
  });

  it("proof.registered says DELIVERED", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");

    const response = await post(deliveryUrl("proof", deliveryId), {
      client_submission_id: randomUUID(),
      received_by: "Maria Souza",
      photo: await storedPhoto(),
    });

    expect(response.statusCode, response.body).toBe(201);

    const [proof] = await webhookData(deliveryId, "proof.registered");

    expect(proof?.status).toBe("DELIVERED");
  });

  it("a blocking occurrence says FAILED and announces delivery.failed", async () => {
    const deliveryId = await deliveryFor("IN_TRANSIT");

    const response = await post(deliveryUrl("report-occurrence", deliveryId), {
      client_submission_id: randomUUID(),
      occurrenceTypeId: blockingTypeId,
    });

    expect(response.statusCode, response.body).toBe(201);

    const [occurrence] = await webhookData(deliveryId, "occurrence.reported");
    expect(occurrence?.status).toBe("FAILED");

    const failed = await webhookData(deliveryId, "delivery.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("FAILED");
    expect(failed[0].occurred_at).toBe(occurrence.occurred_at);
  });
});
