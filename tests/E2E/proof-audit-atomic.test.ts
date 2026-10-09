import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * A proven delivery always reaches the review queue (INV-08).
 *
 * The review card was written AFTER the proof's transaction committed, with
 * its error swallowed into a log line. A database hiccup — or a deploy
 * killing the process — between the commit and that write left a DELIVERED
 * delivery that no person would ever audit. The app's resend could not heal
 * it either: the use case answers a known client_submission_id as done and
 * returns before any side effect.
 *
 * Simulated with a trigger that refuses the card for one delivery, the way a
 * failing statement at that exact point would.
 */
const prisma = new PrismaClient();

const BUSINESS = "018fd951-0000-7000-8000-00000000000a";

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;
let shipperId = "";

const storedKeys: string[] = [];

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${BUSINESS}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryInTransit(): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: BUSINESS,
      shipperId,
      driverId: seed.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

const prove = (deliveryId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/delivery/proof/${deliveryId}/business/${BUSINESS}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: body,
  });

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666778000191",
  });

  shipperId = (
    await prisma.shipper.create({ data: { name: "Embarcador", businessId: BUSINESS } })
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

describe("a proof whose review card cannot be written", () => {
  it("is not recorded without its card, and the resend records both", async () => {
    const deliveryId = await deliveryInTransit();
    const body = {
      client_submission_id: randomUUID(),
      received_by: "Maria Souza",
      photo: await storedPhoto(),
    };

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "refuse_proof_audit_for_test"() RETURNS trigger AS $$
      BEGIN
        IF NEW."deliveryId" = '${deliveryId}' THEN
          RAISE EXCEPTION 'review card refused by the test';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "refuse_proof_audit_for_test"
        BEFORE INSERT OR UPDATE ON "delivery_proof_audit"
        FOR EACH ROW EXECUTE FUNCTION "refuse_proof_audit_for_test"()
    `);

    try {
      await prove(deliveryId, body);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "refuse_proof_audit_for_test" ON "delivery_proof_audit"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "refuse_proof_audit_for_test"()`,
      );
    }

    // What the app's outbox does after a failed or lost answer.
    const resend = await prove(deliveryId, body);

    expect(resend.statusCode, resend.body).toBe(201);

    // The assertion this file exists for: a DELIVERED delivery with no card
    // is a receipt nobody will ever look at.
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.status).toBe("DELIVERED");
    expect(
      await prisma.deliveryProofAudit.count({ where: { deliveryId } }),
    ).toBe(1);
  });

  it("fails as a whole: no DELIVERED stamp and no proof event without the card", async () => {
    const deliveryId = await deliveryInTransit();
    const body = {
      client_submission_id: randomUUID(),
      photo: await storedPhoto(),
    };

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "refuse_proof_audit_for_test"() RETURNS trigger AS $$
      BEGIN
        IF NEW."deliveryId" = '${deliveryId}' THEN
          RAISE EXCEPTION 'review card refused by the test';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "refuse_proof_audit_for_test"
        BEFORE INSERT OR UPDATE ON "delivery_proof_audit"
        FOR EACH ROW EXECUTE FUNCTION "refuse_proof_audit_for_test"()
    `);

    let statusCode = 0;

    try {
      statusCode = (await prove(deliveryId, body)).statusCode;
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "refuse_proof_audit_for_test" ON "delivery_proof_audit"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "refuse_proof_audit_for_test"()`,
      );
    }

    // A 5xx the app retries, not a 201 for a proof with nobody to review it.
    expect(statusCode).toBeGreaterThanOrEqual(500);

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.status).toBe("IN_TRANSIT");
    expect(
      await prisma.deliveryEvent.count({
        where: { client_submission_id: body.client_submission_id },
      }),
    ).toBe(0);
  });

  it("opens exactly one card for an ordinary proof and its resend", async () => {
    const deliveryId = await deliveryInTransit();
    const body = {
      client_submission_id: randomUUID(),
      photo: await storedPhoto(),
    };

    expect((await prove(deliveryId, body)).statusCode).toBe(201);
    expect((await prove(deliveryId, body)).statusCode).toBe(201);

    const cards = await prisma.deliveryProofAudit.findMany({ where: { deliveryId } });

    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe("PENDING");
  });
});
