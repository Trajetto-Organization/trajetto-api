import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";
import { operationDay } from "@/shared/route/operation-day-rules";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Proving a delivery is reporting a DELIVERED occurrence (decision 14.3;
 * design §4.3–§4.7), through the real application and a real database:
 * the new report and the installed app's proof route write the same rows —
 * the occurrence (category, receipt, signature, who received) and the PROOF
 * event that names it with the same submission key — and the same effect
 * (DELIVERED, audit card, `proof.registered` and `delivery.delivered`, never
 * `occurrence.reported`). Requirements, replays, races, the tower's approval
 * at the receipt's instant, tenant and role guards.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe1d0-0000-7000-8000-00000000000a";
const OTHER = "018fe1d0-0000-7000-8000-00000000000b";

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let other: FleetDriverSeed;
let uploads: UploadService;
let shipperId = "";

const storedKeys: string[] = [];

async function storedPhoto(businessId = CARRIER): Promise<string> {
  const key = `deliveryPhotos/${businessId}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryInTransit(): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId,
      driverId: carrier.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

async function typeId(
  systemKey: string,
  businessId = CARRIER,
): Promise<string> {
  return (
    await prisma.occurrenceType.findUniqueOrThrow({
      where: { businessId_system_key: { businessId, system_key: systemKey } },
    })
  ).id;
}

const report = (
  deliveryId: string,
  token: string,
  body: Record<string, unknown>,
  businessId = CARRIER,
) =>
  app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const legacyProof = (deliveryId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/delivery/proof/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.driverToken}` },
    payload: body,
  });

/** Webhook rows queued for this delivery, by topic. */
async function webhookTopics(deliveryId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ topic: string }>>`
    SELECT "topic" FROM "webhook_delivery"
     WHERE "businessId" = ${CARRIER} AND "payload"::text LIKE ${`%${deliveryId}%`}
     ORDER BY "created_at", "topic"
  `;

  return rows.map((row) => row.topic).sort();
}

const refusal = (response: {
  statusCode: number;
  json: () => { code?: string };
}) => `${response.statusCode} ${response.json().code}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666889000191",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55666889000272",
  });

  await ensureDefaultOccurrenceTypes(prisma, CARRIER);
  await ensureDefaultOccurrenceTypes(prisma, OTHER);

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
    })
  ).id;

  // Somebody's ERP, so `announce` writes rows to assert on.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhook",
      secret: "segredo-do-teste",
      businessId: CARRIER,
      topics: [
        "delivery.delivered",
        "proof.registered",
        "occurrence.reported",
        "delivery.failed",
      ],
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a driver reporting the default delivery type", () => {
  it("writes the occurrence and the PROOF naming it, with today's whole effect", async () => {
    const deliveryId = await deliveryInTransit();
    const submission = randomUUID();
    const receipt = await storedPhoto();
    const signature = await storedPhoto();

    const response = await report(deliveryId, carrier.driverToken, {
      occurrenceTypeId: await typeId("delivered_default"),
      client_submission_id: submission,
      receipt_photo: receipt,
      signature,
      received_by: "Maria (portaria)",
      occurred_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      message: "Entrega registrada com sucesso!",
      data: {
        category: "DELIVERED",
        delivery_status: "DELIVERED",
        authorization_status: "NOT_REQUIRED",
      },
    });

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: response.json().data.id },
    });
    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(occurrence).toMatchObject({
      category: "DELIVERED",
      businessId: CARRIER,
      client_submission_id: submission,
      received_by: "Maria (portaria)",
    });
    expect(proof).toMatchObject({
      occurrenceId: occurrence.id,
      client_submission_id: submission,
      photo: occurrence.receipt_photo,
      signature: occurrence.signature,
      received_by: occurrence.received_by,
    });
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "OCCURRENCE" },
      }),
    ).toBe(0);

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.status).toBe("DELIVERED");
    expect(
      await prisma.deliveryProofAudit.count({ where: { deliveryId } }),
    ).toBe(1);
    expect(await webhookTopics(deliveryId)).toEqual([
      "delivery.delivered",
      "proof.registered",
    ]);
  });

  it("answers the resend and the same key through the legacy route as the same submission", async () => {
    const deliveryId = await deliveryInTransit();
    const submission = randomUUID();
    const receipt = await storedPhoto();
    const body = {
      occurrenceTypeId: await typeId("delivered_default"),
      client_submission_id: submission,
      receipt_photo: receipt,
    };

    const first = await report(deliveryId, carrier.driverToken, body);
    const again = await report(deliveryId, carrier.driverToken, body);
    const legacy = await legacyProof(deliveryId, {
      client_submission_id: submission,
      photo: receipt,
    });

    expect(first.statusCode).toBe(201);
    expect(again.json().data).toMatchObject({
      id: first.json().data.id,
      replayed: true,
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "PROOF" },
      }),
    ).toBe(1);
    expect(
      await prisma.deliveryOccurrence.count({ where: { deliveryId } }),
    ).toBe(1);
  });

  it("records one proof for the same submission sent twice at once", async () => {
    const deliveryId = await deliveryInTransit();
    const body = {
      occurrenceTypeId: await typeId("delivered_default"),
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
    };

    const responses = await Promise.all(
      [1, 2].map(() => report(deliveryId, carrier.driverToken, body)),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201,
    ]);
    expect(
      new Set(responses.map((response) => response.json().data.id)).size,
    ).toBe(1);
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "PROOF" },
      }),
    ).toBe(1);
    expect(await webhookTopics(deliveryId)).toEqual([
      "delivery.delivered",
      "proof.registered",
    ]);
  });

  it("refuses a missing receipt with its code, the panel with DRIVER_ONLY, and a pause type", async () => {
    const deliveryId = await deliveryInTransit();

    expect(
      refusal(
        await report(deliveryId, carrier.driverToken, {
          occurrenceTypeId: await typeId("delivered_default"),
          client_submission_id: randomUUID(),
        }),
      ),
    ).toBe("400 OCCURRENCE_RECEIPT_PHOTO_REQUIRED");
    expect(
      refusal(
        await report(deliveryId, carrier.managerToken, {
          occurrenceTypeId: await typeId("delivered_default"),
          client_submission_id: randomUUID(),
          receipt_photo: await storedPhoto(),
        }),
      ),
    ).toBe("403 DRIVER_ONLY");
    expect(
      refusal(
        await report(deliveryId, carrier.driverToken, {
          occurrenceTypeId: await typeId("pause_meal"),
          client_submission_id: randomUUID(),
        }),
      ),
    ).toBe("400 OCCURRENCE_TYPE_WRONG_CATEGORY");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
        .status,
    ).toBe("IN_TRANSIT");
  });

  it("answers another company's type and another company's delivery like missing ones", async () => {
    const deliveryId = await deliveryInTransit();

    expect(
      refusal(
        await report(deliveryId, carrier.driverToken, {
          occurrenceTypeId: await typeId("delivered_default", OTHER),
          client_submission_id: randomUUID(),
          receipt_photo: await storedPhoto(),
        }),
      ),
    ).toBe("404 OCCURRENCE_TYPE_NOT_FOUND");

    // The other carrier's driver, on this carrier's delivery, under his own company.
    expect(
      refusal(
        await report(
          deliveryId,
          other.driverToken,
          {
            occurrenceTypeId: await typeId("delivered_default", OTHER),
            client_submission_id: randomUUID(),
            receipt_photo: await storedPhoto(OTHER),
          },
          OTHER,
        ),
      ),
    ).toBe("404 DELIVERY_NOT_FOUND");
  });
});

describe("the installed app's proof route", () => {
  it("lands on the default type with the old answer", async () => {
    const deliveryId = await deliveryInTransit();

    const response = await legacyProof(deliveryId, {
      client_submission_id: randomUUID(),
      photo: await storedPhoto(),
      received_by: "João",
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      message: "Entrega comprovada com sucesso!",
    });

    const occurrence = await prisma.deliveryOccurrence.findFirstOrThrow({
      where: { deliveryId },
    });

    expect(occurrence).toMatchObject({
      category: "DELIVERED",
      occurrenceTypeId: await typeId("delivered_default"),
      received_by: "João",
    });
    expect(await webhookTopics(deliveryId)).toEqual([
      "delivery.delivered",
      "proof.registered",
    ]);
  });

  it("is CLIENT_OUTDATED with what is missing once the default asks for a signature", async () => {
    const deliveryId = await deliveryInTransit();
    const fallback = await typeId("delivered_default");

    await prisma.occurrenceType.update({
      where: { id: fallback },
      data: { requires_signature: true },
    });

    try {
      const response = await legacyProof(deliveryId, {
        client_submission_id: randomUUID(),
        photo: await storedPhoto(),
      });

      expect(refusal(response)).toBe("400 CLIENT_OUTDATED");
      expect(response.json().missing).toEqual(["signature"]);
      expect(response.headers["x-error-code"]).toBe("CLIENT_OUTDATED");
      expect(
        (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
          .status,
      ).toBe("IN_TRANSIT");
    } finally {
      await prisma.occurrenceType.update({
        where: { id: fallback },
        data: { requires_signature: false },
      });
    }
  });
});

describe("a delivery type that asks the tower", () => {
  it("waits PENDING without effect, and the approval proves it at the receipt's instant", async () => {
    const deliveryId = await deliveryInTransit();
    const tower = await prisma.occurrenceType.create({
      data: {
        businessId: CARRIER,
        name: `Entrega com conferência ${randomUUID().slice(0, 6)}`,
        category: "DELIVERED",
        requires_receipt_photo: true,
        requires_authorization: true,
      },
    });
    const tappedAt = new Date(Date.now() - 30 * 60_000);

    const reported = await report(deliveryId, carrier.driverToken, {
      occurrenceTypeId: tower.id,
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
      received_by: "Porteiro",
      occurred_at: tappedAt.toISOString(),
    });

    expect(reported.statusCode, reported.body).toBe(201);
    expect(reported.json()).toMatchObject({
      message: "Entrega registrada. Aguardando autorização da torre.",
      data: { authorization_status: "PENDING", delivery_status: "IN_TRANSIT" },
    });
    expect(await webhookTopics(deliveryId)).toEqual([]);

    const decided = await app.inject({
      method: "POST",
      url: `/delivery/occurrence-authorization/${reported.json().data.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: { decision: "APPROVED" },
    });

    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().data).toMatchObject({ deliveryStatus: "DELIVERED" });

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(delivery.status).toBe("DELIVERED");
    expect(
      Math.abs(delivery.delivered_at!.getTime() - tappedAt.getTime()),
    ).toBeLessThan(2_000);
    expect(proof).toMatchObject({
      occurrenceId: reported.json().data.id,
      reportedById: carrier.driverUserId,
      received_by: "Porteiro",
    });
    expect(
      (
        await prisma.deliveryOccurrence.findUniqueOrThrow({
          where: { id: reported.json().data.id },
        })
      ).authorization_status,
    ).toBe("APPROVED");
    expect(await webhookTopics(deliveryId)).toEqual([
      "delivery.delivered",
      "proof.registered",
    ]);
  });
});

describe("the readers that count problems, not deliveries", () => {
  it('leaves a DELIVERED occurrence out of "Ocorrências hoje" and counts a problem', async () => {
    const deliveries = new DeliveryRepository();
    const today = () => operationDay("America/Sao_Paulo", new Date());
    const before = (await deliveries.operationBacklog(CARRIER, today()))
      .occurrencesToday;

    const proven = await deliveryInTransit();

    await report(proven, carrier.driverToken, {
      occurrenceTypeId: await typeId("delivered_default"),
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
    });

    expect(
      (await deliveries.operationBacklog(CARRIER, today())).occurrencesToday,
    ).toBe(before);

    const problem = await prisma.occurrenceType.create({
      data: {
        businessId: CARRIER,
        name: `Portão fechado ${randomUUID().slice(0, 6)}`,
      },
    });

    await report(await deliveryInTransit(), carrier.driverToken, {
      occurrenceTypeId: problem.id,
      client_submission_id: randomUUID(),
    });

    expect(
      (await deliveries.operationBacklog(CARRIER, today())).occurrencesToday,
    ).toBe(before + 1);
  });

  it("never shows the DELIVERED occurrence on the public tracking page: the PROOF already says it", async () => {
    const deliveryId = await deliveryInTransit();
    const recipients = new ExternalRecipientRepository();
    const recipient = await recipients.ensureForDelivery({
      deliveryId,
      businessId: CARRIER,
      name: "Cliente",
      email: "cliente@example.com",
      telephone: null,
    });

    await report(deliveryId, carrier.driverToken, {
      occurrenceTypeId: await typeId("delivered_default"),
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
    });

    const source = await recipients.findByToken(recipient.access_token);

    expect(source?.delivery.status).toBe("DELIVERED");
    expect(source?.occurrences).toEqual([]);
    expect(source?.events.map((event) => event.type)).toContain("PROOF");
  });
});

/**
 * Decision 14.8, design §7.2 of the ICP proof: the PROOF event says who sent
 * it (DRIVER_APP), from which phone and build, when the receipt photo was
 * taken and on which route. The proof document prints all of it.
 */
describe("what the PROOF event records about the phone", () => {
  it("stores the photo instant, the phone and the app build, and the driver as its actor", async () => {
    const deliveryId = await deliveryInTransit();
    const tappedAt = new Date(Date.now() - 10 * 60_000);
    const photoAt = new Date(tappedAt.getTime() - 60_000);

    const response = await app.inject({
      method: "POST",
      url: `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
      headers: {
        authorization: `Bearer ${carrier.driverToken}`,
        "x-trajetto-client-version":
          "platform=android; version=1.5.0; build=51; contract=3",
      },
      payload: {
        occurrenceTypeId: await typeId("delivered_default"),
        client_submission_id: randomUUID(),
        receipt_photo: await storedPhoto(),
        occurred_at: tappedAt.toISOString(),
        photo_taken_at: photoAt.toISOString(),
        device_id: "A1B2C3D4E5F60718",
      },
    });

    expect(response.statusCode, response.body).toBe(201);

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(proof).toMatchObject({
      actor: "DRIVER_APP",
      device: "android 1.5.0 (build 51)",
      device_id: "a1b2c3d4e5f60718",
    });
    expect(proof.photo_taken_at?.toISOString()).toBe(photoAt.toISOString());
  });

  it("drops what it cannot read instead of refusing the proof", async () => {
    const deliveryId = await deliveryInTransit();

    const response = await legacyProof(deliveryId, {
      client_submission_id: randomUUID(),
      photo: await storedPhoto(),
      photo_taken_at: "ontem à tarde",
      device_id: "meu-celular",
    });

    expect(response.statusCode, response.body).toBe(201);

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(proof).toMatchObject({
      actor: "DRIVER_APP",
      device_id: null,
      photo_taken_at: null,
    });
  });
});
