import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A submission key spent elsewhere, against the real unique indexes (K13).
 *
 * `client_submission_id` is unique on the whole delivery_event and
 * delivery_occurrence tables, while the replay lookups only see the caller's
 * company. A key another company already used passed the lookup, met the
 * global index at the insert and answered 500 — a status the app's outbox
 * retries forever. And the same key sent for another delivery of the same
 * company was answered as the first delivery's replay. Both are 409
 * SUBMISSION_ID_REUSED now, and nothing is written.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

const CARRIER = "018fe1e0-0000-7000-8000-00000000000a";
const OTHER = "018fe1e0-0000-7000-8000-00000000000b";

async function deliveryInTransit(seed: FleetDriverSeed): Promise<string> {
  const shipper = await prisma.shipper.create({
    data: { name: `Embarcador ${randomUUID()}`, businessId: seed.businessId },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: seed.businessId,
      shipperId: shipper.id,
      driverId: seed.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

const absentTypes: Record<string, string> = {};

async function absentTypeId(businessId: string): Promise<string> {
  return absentTypes[businessId];
}

const arrival = (seed: FleetDriverSeed, deliveryId: string, key: string) =>
  app.inject({
    method: "POST",
    url: `/delivery/arrival/${deliveryId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: { client_submission_id: key, latitude: -23.55, longitude: -46.63 },
  });

const occurrence = async (
  seed: FleetDriverSeed,
  deliveryId: string,
  key: string,
) =>
  app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: {
      occurrenceTypeId: await absentTypeId(seed.businessId),
      client_submission_id: key,
    },
  });

const refusal = (response: {
  statusCode: number;
  json: () => { code?: string };
}) => `${response.statusCode} ${response.json().code}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666990000191",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55666990000272",
  });

  for (const businessId of [CARRIER, OTHER]) {
    await ensureDefaultOccurrenceTypes(prisma, businessId);

    absentTypes[businessId] = (
      await prisma.occurrenceType.create({
        data: {
          name: "Cliente ausente",
          category: "NOT_DELIVERED",
          businessId,
        },
      })
    ).id;
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("an arrival key", () => {
  it("answers 409, not 500, when another company already spent it", async () => {
    const key = randomUUID();

    const theirs = await arrival(other, await deliveryInTransit(other), key);
    expect(theirs.statusCode, theirs.body).toBe(201);

    const deliveryId = await deliveryInTransit(carrier);
    const ours = await arrival(carrier, deliveryId, key);

    expect(refusal(ours), ours.body).toBe("409 SUBMISSION_ID_REUSED");
    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(0);
  });

  it("is refused on another delivery of the same company", async () => {
    const key = randomUUID();

    const first = await arrival(carrier, await deliveryInTransit(carrier), key);
    expect(first.statusCode, first.body).toBe(201);

    const second = await deliveryInTransit(carrier);
    const reused = await arrival(carrier, second, key);

    expect(refusal(reused), reused.body).toBe("409 SUBMISSION_ID_REUSED");
    expect(
      await prisma.deliveryEvent.count({ where: { deliveryId: second } }),
    ).toBe(0);
  });
});

describe("an occurrence key", () => {
  it("answers 409, not 500, when another company already spent it", async () => {
    const key = randomUUID();

    const theirs = await occurrence(other, await deliveryInTransit(other), key);
    expect(theirs.statusCode, theirs.body).toBe(201);

    const deliveryId = await deliveryInTransit(carrier);
    const ours = await occurrence(carrier, deliveryId, key);

    expect(refusal(ours), ours.body).toBe("409 SUBMISSION_ID_REUSED");
    expect(
      await prisma.deliveryOccurrence.count({ where: { deliveryId } }),
    ).toBe(0);
  });

  it("is refused on another delivery instead of answering the first one", async () => {
    const key = randomUUID();

    const first = await occurrence(
      carrier,
      await deliveryInTransit(carrier),
      key,
    );
    expect(first.statusCode, first.body).toBe(201);

    const second = await deliveryInTransit(carrier);
    const reused = await occurrence(carrier, second, key);

    expect(refusal(reused), reused.body).toBe("409 SUBMISSION_ID_REUSED");
  });

  it("still replays on the delivery it was spent on", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    const first = await occurrence(carrier, deliveryId, key);
    const again = await occurrence(carrier, deliveryId, key);

    expect(first.statusCode, first.body).toBe(201);
    expect(again.statusCode, again.body).toBeLessThan(300);
    expect(again.json().data).toMatchObject({
      id: first.json().data.id,
      replayed: true,
    });
  });
});
