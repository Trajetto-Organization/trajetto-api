import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The readers of a DELIVERED occurrence (decision 14.3; design §4.5, §7.3,
 * §11), against a real database, review r1 of m-occ-categories:
 *
 * - the tower's queue shows the receipt, the signature and who received a
 *   delivery request — approving it proves the delivery, so the operator
 *   must see what is being approved;
 * - the public events feed never names a delivery request
 *   `occurrence.reported`, not even after the approval: its fact is the PROOF;
 * - the "Ocorrências" feed keeps proofs out of the severities and filters them
 *   by category.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe1d2-0000-7000-8000-00000000000a";
const OTHER = "018fe1d2-0000-7000-8000-00000000000b";

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let other: FleetDriverSeed;
let uploads: UploadService;
let shipperId = "";
let towerTypeId = "";
let defaultTypeId = "";

const storedKeys: string[] = [];

async function storedPhoto(businessId = CARRIER): Promise<string> {
  const key = `deliveryPhotos/${businessId}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryInTransit(
  recipient = "Mercado Central",
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: recipient,
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

const report = (deliveryId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.driverToken}` },
    payload: body,
  });

const get = (url: string, token: string) =>
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

/** The NDJSON feed: the meta line, then one row per occurrence. */
async function feed(query: string, token = carrier.managerToken) {
  const response = await get(
    `/delivery/list-occurrences?page=1&pageSize=50&${query}`,
    token,
  );

  expect(response.statusCode, response.body).toBe(200);

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { meta: first.meta, rows: rows as Array<Record<string, any>> };
}

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666889000353",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55666889000434",
  });

  await ensureDefaultOccurrenceTypes(prisma, CARRIER);
  await ensureDefaultOccurrenceTypes(prisma, OTHER);

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
    })
  ).id;

  towerTypeId = (
    await prisma.occurrenceType.create({
      data: {
        businessId: CARRIER,
        name: "Entrega com conferência",
        category: "DELIVERED",
        requires_receipt_photo: true,
        requires_authorization: true,
      },
    })
  ).id;

  defaultTypeId = (
    await prisma.occurrenceType.findUniqueOrThrow({
      where: {
        businessId_system_key: {
          businessId: CARRIER,
          system_key: "delivered_default",
        },
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

describe("a delivery request in the tower's queue", () => {
  let occurrenceId = "";
  let deliveryId = "";
  let receipt = "";
  let signature = "";

  beforeAll(async () => {
    deliveryId = await deliveryInTransit("Padaria do Bairro");
    receipt = await storedPhoto();
    signature = await storedPhoto();

    const reported = await report(deliveryId, {
      occurrenceTypeId: towerTypeId,
      client_submission_id: randomUUID(),
      receipt_photo: receipt,
      signature,
      received_by: "Porteiro Zé",
    });

    expect(reported.statusCode, reported.body).toBe(201);
    occurrenceId = reported.json().data.id;
  });

  it("shows the category, the signed receipt and signature, and who received", async () => {
    const queue = await get(
      "/delivery/occurrence-authorizations",
      carrier.managerToken,
    );

    expect(queue.statusCode, queue.body).toBe(200);

    const row = (queue.json().data as Array<Record<string, any>>).find(
      (entry) => entry.id === occurrenceId,
    );

    expect(row).toMatchObject({
      category: "DELIVERED",
      received_by: "Porteiro Zé",
    });
    // Signed URLs, never the raw storage key.
    expect(row?.receipt_photo_url).toEqual(expect.stringContaining(receipt));
    expect(row?.receipt_photo_url).not.toBe(receipt);
    expect(row?.signature_url).toEqual(expect.stringContaining(signature));
    expect(row?.signature_url).not.toBe(signature);
  });

  it("is invisible to another company, and refused to a driver", async () => {
    const own = await get(
      "/delivery/occurrence-authorizations",
      other.managerToken,
    );

    expect(own.statusCode).toBe(200);
    expect(
      (own.json().data as Array<{ id: string }>).some(
        (entry) => entry.id === occurrenceId,
      ),
    ).toBe(false);

    const peeking = await get(
      `/delivery/occurrence-authorizations?businessId=${CARRIER}`,
      other.managerToken,
    );

    expect(peeking.statusCode).toBe(403);

    const driver = await get(
      "/delivery/occurrence-authorizations",
      carrier.driverToken,
    );

    expect(driver.statusCode).toBe(403);
    expect(driver.json().code).toBe("PERMISSION_DENIED");
  });

  it("once approved, is proof.registered on the public feed and never occurrence.reported", async () => {
    const decided = await app.inject({
      method: "POST",
      url: `/delivery/occurrence-authorization/${occurrenceId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: { decision: "APPROVED" },
    });

    expect(decided.statusCode, decided.body).toBe(200);

    // The OCCURRENCE event of the request still exists, now APPROVED.
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "OCCURRENCE" },
      }),
    ).toBe(1);

    const page = await new IntegrationRepository().listEvents({
      businessId: CARRIER,
      limit: 200,
    } as never);

    const topics = page.data
      .filter((event) => event.delivery.id === deliveryId)
      .map((event) => event.topic);

    expect(topics).toContain("proof.registered");
    expect(topics).not.toContain("occurrence.reported");
  });
});

describe("the Ocorrências feed with proofs in it", () => {
  let proofId = "";
  let problemId = "";

  beforeAll(async () => {
    const proven = await report(await deliveryInTransit("Feira Livre"), {
      occurrenceTypeId: defaultTypeId,
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
    });

    expect(proven.statusCode, proven.body).toBe(201);
    proofId = proven.json().data.id;

    const informative = await prisma.occurrenceType.create({
      data: { businessId: CARRIER, name: "Cliente pediu para ligar" },
    });

    const problem = await report(await deliveryInTransit("Açougue"), {
      occurrenceTypeId: informative.id,
      client_submission_id: randomUUID(),
    });

    expect(problem.statusCode, problem.body).toBe(201);
    problemId = problem.json().data.id;
  });

  it("never files a proof under the informational severity", async () => {
    const { meta, rows } = await feed("severity=informational");
    const listed = rows.map((row) => row.id);

    expect(listed).toContain(problemId);
    expect(listed).not.toContain(proofId);
    expect(meta.searchMeta.informational).toBe(
      rows.filter((row) => row.category === "NOT_DELIVERED").length,
    );
  });

  it("filters by category and counts the delivered apart", async () => {
    const delivered = await feed("category=DELIVERED");

    expect(delivered.rows.every((row) => row.category === "DELIVERED")).toBe(
      true,
    );
    expect(delivered.rows.map((row) => row.id)).toContain(proofId);
    expect(delivered.meta.searchMeta.delivered).toBe(delivered.rows.length);

    const problems = await feed("category=NOT_DELIVERED");

    expect(problems.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([problemId]),
    );
    expect(problems.rows.some((row) => row.id === proofId)).toBe(false);

    const facet = Object.fromEntries(
      (
        problems.meta.searchMeta.facets.category as Array<{
          value: string;
          count: number;
        }>
      ).map((option) => [option.value, option.count]),
    );

    expect(facet.DELIVERED).toBe(delivered.rows.length);
    expect(facet.NOT_DELIVERED).toBe(problems.rows.length);
  });

  it("keeps another company's proofs out", async () => {
    const { rows } = await feed("category=DELIVERED", other.managerToken);

    expect(rows.some((row) => row.id === proofId)).toBe(false);
  });
});
