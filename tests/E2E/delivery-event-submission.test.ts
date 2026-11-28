import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The trail's submission keys in a table of their own (plano-escala F2-14).
 *
 * delivery_event moves to a table partitioned by month on its id, which
 * cannot hold the global unique index on client_submission_id that keeps a
 * resent arrival, proof or "a caminho" from becoming a second event. So
 * the key also lands in delivery_event_submission, in the same commit as
 * its event, and the promise has to hold through EITHER index:
 *
 *  - a resend is answered from the key's own table, even when the event
 *    row no longer carries the key (the partitioned trail of wave 11);
 *  - a resend the previous image recorded only on the event (the rolling
 *    deploy) is still answered, through the legacy column;
 *  - a key the new table holds for another company meets its primary key
 *    and is the same 409 SUBMISSION_ID_REUSED, with nothing written;
 *  - the same arrival sent twice at once is one event and one key;
 *  - the migration's backfill copies the keys the trail held, and the
 *    nightly purge removes only the keys past the retention.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

const CARRIER = "019a8f10-0000-7000-8000-00000000000a";
const OTHER = "019a8f10-0000-7000-8000-00000000000b";

const DAY_MS = 24 * 60 * 60 * 1000;

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

const arrival = (seed: FleetDriverSeed, deliveryId: string, key: string) =>
  app.inject({
    method: "POST",
    url: `/delivery/arrival/${deliveryId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: { client_submission_id: key, latitude: -23.55, longitude: -46.63 },
  });

const keyRow = (key: string) =>
  prisma.deliveryEventSubmission.findUnique({
    where: { client_submission_id: key },
  });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55777990000191",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55777990000272",
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the key of an arrival", () => {
  it("is written with its event, in the same commit", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    const sent = await arrival(carrier, deliveryId, key);
    expect(sent.statusCode, sent.body).toBe(201);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ARRIVAL" },
    });

    expect(await keyRow(key)).toMatchObject({
      event_id: event.id,
      businessId: CARRIER,
    });
  });

  it("answers a resend from its own table when the event no longer carries it", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    const first = await arrival(carrier, deliveryId, key);
    expect(first.statusCode, first.body).toBe(201);

    // The partitioned trail of wave 11 holds no unique on the column: the
    // key's own table is all the resend can be answered from.
    await prisma.$executeRaw`
      UPDATE "delivery_event" SET "client_submission_id" = NULL
      WHERE "deliveryId" = ${deliveryId}
    `;

    const again = await arrival(carrier, deliveryId, key);

    expect(again.statusCode, again.body).toBe(first.statusCode);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(1);
  });

  it("still answers a resend the previous image recorded only on the event", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    // What the image before this one writes during the rolling deploy.
    await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId,
        businessId: CARRIER,
        actor: "DRIVER_APP",
        client_submission_id: key,
      },
    });

    const resent = await arrival(carrier, deliveryId, key);

    expect(resent.statusCode, resent.body).toBe(201);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(1);
    expect(await keyRow(key)).toBeNull();
  });

  it("is refused with 409 when the key's table holds it for another company", async () => {
    const key = randomUUID();
    const theirs = await deliveryInTransit(other);
    const event = await prisma.deliveryEvent.create({
      data: { type: "ARRIVAL", deliveryId: theirs, businessId: OTHER },
    });

    // Only the new table knows this key: the insert meets its primary key,
    // not the legacy unique on the event.
    await prisma.deliveryEventSubmission.create({
      data: {
        client_submission_id: key,
        event_id: event.id,
        businessId: OTHER,
      },
    });

    const deliveryId = await deliveryInTransit(carrier);
    const ours = await arrival(carrier, deliveryId, key);

    expect(`${ours.statusCode} ${ours.json().code}`, ours.body).toBe(
      "409 SUBMISSION_ID_REUSED",
    );
    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(0);
    expect(await keyRow(key)).toMatchObject({
      event_id: event.id,
      businessId: OTHER,
    });
  });

  it("records one event and one key when the same arrival comes twice at once", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    const answers = await Promise.all([
      arrival(carrier, deliveryId, key),
      arrival(carrier, deliveryId, key),
    ]);

    for (const answer of answers) {
      expect(answer.statusCode, answer.body).toBe(201);
    }

    expect(await prisma.deliveryEvent.count({ where: { deliveryId } })).toBe(1);
    expect(
      await prisma.deliveryEventSubmission.count({
        where: { client_submission_id: key },
      }),
    ).toBe(1);
  });
});

describe("the other keyed events of the trail", () => {
  it("writes the key of a proof with its event", async () => {
    const { DeliveryRepository } =
      await import("@/modules/delivery/repositories/delivery-repository");

    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);

    await new DeliveryRepository().registerDeliveryProof(
      {
        type: "PROOF",
        deliveryId,
        reportedById: carrier.driverUserId,
        actor: "DRIVER_APP",
        client_submission_id: key,
        received_by: "Recebedor",
      },
      "IN_TRANSIT",
    );

    const proof = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "PROOF" },
    });

    expect(await keyRow(key)).toMatchObject({
      event_id: proof.id,
      businessId: CARRIER,
    });
  });

  it("writes the key of an 'a caminho' with its event", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(carrier);
    const route = await prisma.route.create({
      data: {
        code: 1,
        scheduled_date: new Date(),
        status: "IN_PROGRESS",
        started_at: new Date(Date.now() - 60 * 60 * 1000),
        businessId: CARRIER,
        driverId: carrier.driverId,
        stops: { create: [{ deliveryId, sequence: 10 }] },
      },
      include: { stops: true },
    });

    const marked = await app.inject({
      method: "POST",
      url: `/route/on-the-way/${route.stops[0].id}/route/${route.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.driverToken}` },
      payload: { client_submission_id: key },
    });
    expect(marked.statusCode, marked.body).toBeLessThan(300);

    const event = await prisma.deliveryEvent.findFirstOrThrow({
      where: { deliveryId, type: "ON_THE_WAY" },
    });

    expect(await keyRow(key)).toMatchObject({
      event_id: event.id,
      businessId: CARRIER,
    });

    // And its resend is answered from the key's table too.
    await prisma.$executeRaw`
      UPDATE "delivery_event" SET "client_submission_id" = NULL
      WHERE "id" = ${event.id}
    `;

    const again = await app.inject({
      method: "POST",
      url: `/route/on-the-way/${route.stops[0].id}/route/${route.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.driverToken}` },
      payload: { client_submission_id: key },
    });

    expect(again.statusCode, again.body).toBe(marked.statusCode);
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "ON_THE_WAY" },
      }),
    ).toBe(1);
  });
});

describe("the migration's backfill", () => {
  it("copies every key the trail holds, once, with its event and company", async () => {
    const key = randomUUID();
    const deliveryId = await deliveryInTransit(other);
    const event = await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId,
        businessId: OTHER,
        client_submission_id: key,
      },
    });

    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20261117190000_delivery_event_submission/migration.sql",
      ),
      "utf8",
    );
    const backfill = sql.slice(
      sql.indexOf('INSERT INTO "delivery_event_submission"'),
    );

    // Twice: a hand re-run of the statement changes nothing.
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(backfill);

    expect(await keyRow(key)).toMatchObject({
      event_id: event.id,
      businessId: OTHER,
    });
  });
});

describe("the nightly purge", () => {
  it("removes the keys past the retention and keeps the rest", async () => {
    const { purgeDeliveryEventSubmissions } =
      await import("@/jobs/cron/cleanup-delivery-event-submissions-job");

    const now = new Date();
    const old = randomUUID();
    const recent = randomUUID();

    await prisma.deliveryEventSubmission.createMany({
      data: [
        {
          client_submission_id: old,
          event_id: randomUUID(),
          businessId: CARRIER,
          created_at: new Date(now.getTime() - 91 * DAY_MS),
        },
        {
          client_submission_id: recent,
          event_id: randomUUID(),
          businessId: CARRIER,
          created_at: new Date(now.getTime() - 89 * DAY_MS),
        },
      ],
    });

    const result = await purgeDeliveryEventSubmissions({ now });

    expect(result.stoppedEarly).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await keyRow(old)).toBeNull();
    expect(await keyRow(recent)).not.toBeNull();
  });
});
