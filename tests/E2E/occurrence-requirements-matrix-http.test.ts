import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import type {
  MissingRequirement,
  ReportAttachments,
  ReportRequirements,
} from "@/modules/occurrence-type/rules/occurrence-category-rules";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * When each requirement of an occurrence type binds (K17), flag by flag,
 * through the real route, storage and database.
 *
 * The shared fixture (tests/unitaires/occurrence-type/fixtures/
 * occurrence-requirements-cases.json, also run by the web dialog and the
 * app) pins the pure rule; this runs every one of its report cases as the
 * app sends it — a type with those flags, the attachments stored by the
 * presigned flow — and expects the API's answer to be the rule's: the first
 * missing requirement as the 400, or the report accepted. Then the two flags
 * the rule does not carry: the tower's authorization (accepted, no effect
 * until the decision) and a requirement switched on after an offline tap
 * (K2: accepted and flagged).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let uploads: UploadService;
let shipperId = "";

const CARRIER = "018fe230-0000-7000-8000-00000000000a";

const storedKeys: string[] = [];

interface SharedCases {
  missing: Array<{
    name: string;
    // A report case is never about a pause (pauses take no attachments).
    type: ReportRequirements & { category: "DELIVERED" | "NOT_DELIVERED" };
    sent: ReportAttachments;
    missing: MissingRequirement[];
  }>;
}

const CASES = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../unitaires/occurrence-type/fixtures/occurrence-requirements-cases.json",
    ),
    "utf8",
  ),
) as SharedCases;

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

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
      street: "Rua Um",
      businessId: CARRIER,
      shipperId,
      driverId: carrier.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

let typeSeq = 0;

async function typeWith(
  flags: Partial<{
    category: "DELIVERED" | "NOT_DELIVERED";
    requires_photo: boolean;
    requires_receipt_photo: boolean;
    requires_signature: boolean;
    requires_authorization: boolean;
    blocks_delivery: boolean;
    requirements_changed_at: Date;
  }>,
): Promise<string> {
  typeSeq += 1;

  const type = await prisma.occurrenceType.create({
    data: {
      name: `Tipo ${typeSeq}`,
      businessId: CARRIER,
      category: "NOT_DELIVERED",
      ...flags,
    },
  });

  return type.id;
}

async function report(
  deliveryId: string,
  occurrenceTypeId: string,
  sent: ReportAttachments,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.driverToken}`, ...headers },
    payload: {
      occurrenceTypeId,
      client_submission_id: randomUUID(),
      ...(sent.receipt_photo && { receipt_photo: await storedPhoto() }),
      ...(sent.signature && { signature: await storedPhoto() }),
      ...(sent.photos > 0 && {
        photos: await Promise.all(
          Array.from({ length: sent.photos }, storedPhoto),
        ),
      }),
      ...extra,
    },
  });
}

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667005000191",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
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

describe("every report case of the shared fixture, over HTTP", () => {
  it.each(CASES.missing.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const typeId = await typeWith(entry.type);
      const response = await report(
        await deliveryInTransit(),
        typeId,
        entry.sent,
      );

      const [first] = entry.missing;

      if (first) {
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({
          code: first.code,
          message: first.message,
        });
      } else {
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json().data).toMatchObject({
          category: entry.type.category,
          authorization_status: "NOT_REQUIRED",
          delivery_status:
            entry.type.category === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT",
        });
      }
    },
  );
});

describe("the tower's authorization", () => {
  it.each(["DELIVERED", "NOT_DELIVERED"] as const)(
    "never refuses a %s report: it is accepted, and nothing happens until the decision",
    async (category) => {
      const deliveryId = await deliveryInTransit();
      // A blocking not delivered type would move the delivery when applied;
      // waiting for the tower, it must not.
      const typeId = await typeWith({
        category,
        requires_authorization: true,
        ...(category === "NOT_DELIVERED" && { blocks_delivery: true }),
      });

      const response = await report(deliveryId, typeId, {
        receipt_photo: false,
        signature: false,
        photos: 0,
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().data).toMatchObject({
        authorization_status: "PENDING",
        delivery_status: "IN_TRANSIT",
      });
      expect(
        (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
          .status,
      ).toBe("IN_TRANSIT");
    },
  );
});

describe("a requirement switched on after an offline tap (K2)", () => {
  it("accepts the report tapped before the change and flags it; refuses one tapped after", async () => {
    const changedAt = new Date(Date.now() - 10 * 60_000);
    const typeId = await typeWith({
      category: "NOT_DELIVERED",
      requires_photo: true,
      requirements_changed_at: changedAt,
    });

    const sentAt = { "x-client-sent-at": new Date().toISOString() };
    const nothing = { receipt_photo: false, signature: false, photos: 0 };

    const before = await deliveryInTransit();
    const accepted = await report(
      before,
      typeId,
      nothing,
      { occurred_at: new Date(changedAt.getTime() - 5 * 60_000).toISOString() },
      sentAt,
    );

    expect(accepted.statusCode, accepted.body).toBe(201);

    const flag = await prisma.deliveryEvent.findFirst({
      where: { deliveryId: before, type: "NOTE", actor: "SYSTEM" },
    });

    expect(flag?.note).toContain("Aceita sem a foto anexada");

    const refused = await report(
      await deliveryInTransit(),
      typeId,
      nothing,
      { occurred_at: new Date(changedAt.getTime() + 5 * 60_000).toISOString() },
      sentAt,
    );

    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().code).toBe("OCCURRENCE_PHOTO_REQUIRED");
  });
});
