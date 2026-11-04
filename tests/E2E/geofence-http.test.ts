import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The company's geofence on the driver's actions at the customer's address,
 * over real HTTP and Postgres (plan of 02/11/2026, E4; decisions D12-D14 and
 * the owner's calls of 03/11/2026).
 *
 * - Every driver action records the distance, the accuracy and the verdict
 *   on its event (and on the occurrence).
 * - BLOCK refuses only a FRESH arrival or proof outside the radius (422
 *   ARRIVAL_OUTSIDE_GEOFENCE). An occurrence, and anything the app queued
 *   offline, is accepted and flagged OUTSIDE: a record of the street never
 *   becomes a permanent failure on the driver's phone.
 * - A resend is answered with what was decided then, never re-weighed.
 * - Without accuracy (every app before this one) nothing is ever blocked.
 * - The settings are the company's own: another company's BLOCK does not
 *   reach this one's driver.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe9a0-0000-7000-8000-00000000000a";
const OTHER = "018fe9a0-0000-7000-8000-00000000000b";

/** Praça da Sé, and two positions north of it. */
const ADDRESS = { latitude: -23.55052, longitude: -46.633308 };
const AT_800_M = { latitude: -23.54332, longitude: -46.633308 };
const AT_300_M = { latitude: -23.54782, longitude: -46.633308 };

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;
let shipperId = "";
let otherShipperId = "";
let notDeliveredTypeId = "";
let deliveredTypeId = "";

async function setGeofence(
  businessId: string,
  mode: "DISABLED" | "ALERT" | "BLOCK",
  radius = 500,
) {
  await prisma.businessSettings.upsert({
    where: { businessId },
    create: {
      businessId,
      arrival_geofence_mode: mode,
      arrival_geofence_radius_m: radius,
    },
    update: { arrival_geofence_mode: mode, arrival_geofence_radius_m: radius },
  });
}

/** A delivery on the street with this driver, its address pinned. */
async function onTheStreet(
  seed: FleetDriverSeed,
  shipper: string,
  pinned = true,
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente da Praça",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      address_number: "1",
      businessId: seed.businessId,
      shipperId: shipper,
      driverId: seed.driverId,
      status: "IN_TRANSIT",
      ...(pinned && {
        ...ADDRESS,
        geo_source: "MANUAL" as const,
        geo_updated_at: new Date(),
      }),
    },
    select: { id: true },
  });

  return delivery.id;
}

function arrive(
  seed: FleetDriverSeed,
  deliveryId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/delivery/arrival/${deliveryId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    payload: { client_submission_id: randomUUID(), ...body },
  });
}

function report(
  seed: FleetDriverSeed,
  deliveryId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: { client_submission_id: randomUUID(), ...body },
  });
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666777000101",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55666777000202",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
    })
  ).id;
  otherShipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador alheio", businessId: OTHER },
    })
  ).id;

  notDeliveredTypeId = (
    await prisma.occurrenceType.create({
      data: {
        name: "Cliente ausente (geocerca)",
        category: "NOT_DELIVERED",
        blocks_delivery: false,
        businessId: CARRIER,
      },
    })
  ).id;

  // Nothing to attach, so the proof needs no upload in this test.
  deliveredTypeId = (
    await prisma.occurrenceType.create({
      data: {
        name: "Entrega sem anexos (geocerca)",
        category: "DELIVERED",
        requires_receipt_photo: false,
        requires_signature: false,
        requires_photo: false,
        businessId: CARRIER,
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

describe("under BLOCK", () => {
  beforeAll(async () => {
    await setGeofence(CARRIER, "BLOCK");
  });

  it("refuses a fresh arrival 800 m away and records nothing", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await arrive(carrier, deliveryId, {
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "ARRIVAL_OUTSIDE_GEOFENCE",
    });
    expect(response.json().message).toContain("801 m");
    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(0);
  });

  it("accepts and flags an arrival the app queued offline, and a resend never re-weighs it", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);
    const key = randomUUID();

    const queued = await arrive(
      carrier,
      deliveryId,
      {
        client_submission_id: key,
        ...AT_800_M,
        accuracy: 15,
        occurred_at: minutesAgo(10),
      },
      { "x-client-sent-at": new Date().toISOString() },
    );

    expect(queued.statusCode).toBe(201);

    // The same key again, this time without the tap instant: weighed, it
    // would be a fresh arrival outside the radius. It is the same arrival.
    const resend = await arrive(carrier, deliveryId, {
      client_submission_id: key,
      ...AT_800_M,
      accuracy: 15,
    });

    expect(resend.statusCode).toBe(201);

    const events = await prisma.deliveryEvent.findMany({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      geofence_outcome: "OUTSIDE",
      accuracy_m: 15,
    });
    expect(events[0].distance_m).toBeCloseTo(800.6, 1);
  });

  it("accepts an arrival 300 m away as inside", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await arrive(carrier, deliveryId, {
      ...AT_300_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event.geofence_outcome).toBe("INSIDE");
    expect(event.distance_m).toBeCloseTo(300.2, 1);
  });

  it("never blocks an app that sends no accuracy", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await arrive(carrier, deliveryId, AT_800_M);

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event).toMatchObject({
      geofence_outcome: "NOT_EVALUATED",
      accuracy_m: null,
    });
  });

  it("never blocks an address without a point", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId, false);

    const response = await arrive(carrier, deliveryId, {
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event).toMatchObject({
      geofence_outcome: "NOT_EVALUATED",
      distance_m: null,
    });
  });

  it("accepts and flags an occurrence 800 m away: an occurrence is never refused", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await report(carrier, deliveryId, {
      occurrenceTypeId: notDeliveredTypeId,
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const occurrence = await prisma.deliveryOccurrence.findFirstOrThrow({
      where: { deliveryId },
    });
    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "OCCURRENCE" },
    });

    expect(occurrence.geofence_outcome).toBe("OUTSIDE");
    expect(occurrence.distance_m).toBeCloseTo(800.6, 1);
    expect(event.geofence_outcome).toBe("OUTSIDE");
  });

  it("refuses a fresh proof 800 m away, and records the one made at the door", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const far = await report(carrier, deliveryId, {
      occurrenceTypeId: deliveredTypeId,
      ...AT_800_M,
      accuracy: 15,
    });

    expect(far.statusCode).toBe(422);
    expect(far.json().code).toBe("ARRIVAL_OUTSIDE_GEOFENCE");
    expect(far.json().message).toContain("comprovar a entrega");

    const near = await report(carrier, deliveryId, {
      occurrenceTypeId: deliveredTypeId,
      ...AT_300_M,
      accuracy: 15,
    });

    expect(near.statusCode).toBe(201);

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(proof.geofence_outcome).toBe("INSIDE");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
        .status,
    ).toBe("DELIVERED");
  });

  it("does not reach another company's driver", async () => {
    const deliveryId = await onTheStreet(other, otherShipperId);

    const response = await arrive(other, deliveryId, {
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event.geofence_outcome).toBe("NOT_EVALUATED");
  });
});

describe("under ALERT", () => {
  beforeAll(async () => {
    await setGeofence(CARRIER, "ALERT");
  });

  it("accepts a fresh arrival 800 m away, flagged", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await arrive(carrier, deliveryId, {
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event.geofence_outcome).toBe("OUTSIDE");
  });
});

describe("with the geofence off", () => {
  beforeAll(async () => {
    await setGeofence(CARRIER, "DISABLED");
  });

  it("records the distance without a verdict", async () => {
    const deliveryId = await onTheStreet(carrier, shipperId);

    const response = await arrive(carrier, deliveryId, {
      ...AT_800_M,
      accuracy: 15,
    });

    expect(response.statusCode).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(event.geofence_outcome).toBe("NOT_EVALUATED");
    expect(event.distance_m).toBeCloseTo(800.6, 1);
  });
});
