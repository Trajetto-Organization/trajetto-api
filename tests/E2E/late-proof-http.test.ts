import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Scenario S3 of the plan (K7, decision D27), through the real routes, a real
 * database and real storage: the driver proves without signal, the
 * dispatcher cancels the route (or moves the status), the phone reconnects.
 *
 * The proof used to be refused (404 or 400, a permanent failure in the app)
 * and the receipt was lost. Tapped before the loss, it is Entregue now —
 * back with the driver, flagged, a ticket for the tower; tapped after, it is
 * evidence with no effect, flagged, with the ticket. The cancellation's own
 * line (ROUTE_REMOVED, K8) is on the timeline either way.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let uploads: UploadService;
let shipperId = "";
let reasonId = "";
let deliveredTypeId = "";

const CARRIER = "018fe220-0000-7000-8000-00000000000a";

const storedKeys: string[] = [];
let routeCode = 0;

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

/** A delivery on the driver's running route, as the departure left it. */
async function onTheStreet(): Promise<{ deliveryId: string; routeId: string }> {
  routeCode += 1;

  // One running route per driver and truck: the previous one ends.
  await prisma.route.updateMany({
    where: { businessId: CARRIER, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completed_at: new Date() },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      businessId: CARRIER,
      shipperId,
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
      status: "IN_TRANSIT",
    },
  });

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      businessId: CARRIER,
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      released_at: new Date(Date.now() - 3 * 60 * 60_000),
      started_at: new Date(Date.now() - 2 * 60 * 60_000),
      stops: { create: { deliveryId: delivery.id, sequence: 10 } },
    },
  });

  return { deliveryId: delivery.id, routeId: route.id };
}

const cancel = (routeId: string) =>
  app.inject({
    method: "PATCH",
    url: `/route/cancel-route/${routeId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.managerToken}` },
    payload: { reason: "Caminhão quebrou" },
  });

/** What the outbox sends: the tap, and the phone's clock at the send. */
const prove = async (deliveryId: string, tappedAt: Date) =>
  app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
    headers: {
      authorization: `Bearer ${carrier.driverToken}`,
      "x-client-sent-at": new Date().toISOString(),
    },
    payload: {
      occurrenceTypeId: deliveredTypeId,
      client_submission_id: randomUUID(),
      receipt_photo: await storedPhoto(),
      occurred_at: tappedAt.toISOString(),
    },
  });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667004000191",
  });

  await ensureDefaultOccurrenceTypes(prisma, CARRIER);

  deliveredTypeId = (
    await prisma.occurrenceType.findUniqueOrThrow({
      where: {
        businessId_system_key: {
          businessId: CARRIER,
          system_key: "delivered_default",
        },
      },
    })
  ).id;

  shipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
    })
  ).id;

  reasonId = (
    await prisma.statusChangeReason.create({
      data: { name: "Cliente desistiu", businessId: CARRIER },
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

describe("the driver proves offline, the dispatcher cancels the route", () => {
  it("accepts the proof tapped before the cancellation as Entregue, flagged and sent to the tower", async () => {
    const { deliveryId, routeId } = await onTheStreet();
    const tappedAt = new Date(Date.now() - 5 * 60_000);

    const cancelled = await cancel(routeId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const response = await prove(deliveryId, tappedAt);

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({
      delivery_status: "DELIVERED",
      late_proof: "APPLIED",
    });
    expect(response.json().data.ticket).not.toBeNull();

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery).toMatchObject({
      status: "DELIVERED",
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
    });

    const trail = await prisma.deliveryEvent.findMany({
      where: { deliveryId },
      orderBy: { created_at: "asc" },
    });

    expect(trail.map((event) => event.type)).toEqual(
      expect.arrayContaining(["ROUTE_REMOVED", "NOTE", "PROOF"]),
    );
    expect(trail.find((event) => event.type === "NOTE")?.note).toContain(
      "Comprovante após o cancelamento da Rota",
    );

    expect(await prisma.supportTicket.count({ where: { deliveryId } })).toBe(1);
  });

  it("keeps the proof tapped after the cancellation as evidence with no effect", async () => {
    const { deliveryId, routeId } = await onTheStreet();

    const cancelled = await cancel(routeId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const response = await prove(deliveryId, new Date());

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({
      authorization_status: "SUPERSEDED",
      delivery_status: "PENDING",
      late_proof: "EVIDENCE",
    });

    const occurrence = await prisma.deliveryOccurrence.findFirstOrThrow({
      where: { deliveryId },
    });

    expect(occurrence.authorization_status).toBe("SUPERSEDED");
    expect(occurrence.receipt_photo).not.toBeNull();

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
        .status,
    ).toBe("PENDING");
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "PROOF" },
      }),
    ).toBe(0);
  });

  it("keeps a proof tapped after the cancellation as evidence even when the delivery is edited before the sync", async () => {
    const { deliveryId, routeId } = await onTheStreet();

    const cancelled = await cancel(routeId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const cancelledStop = await prisma.routeStop.findFirstOrThrow({
      where: { deliveryId, routeId },
    });
    expect(cancelledStop.status).toBe("CANCELLED");

    const tappedAt = new Date();

    // Back in Pendente, the dispatcher fixes the address and the phone: both
    // feed the stop's group key (B6/K9). The cancelled stop is no visit any
    // more, so its updated_at — the instant it was called off, which the
    // late-proof verdict reads — must not move.
    const edited = await app.inject({
      method: "PATCH",
      url: `/delivery/update-delivery/${deliveryId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: { street: "Rua Dois", recipient_telephone: "11987654321" },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const stopAfterEdit = await prisma.routeStop.findUniqueOrThrow({
      where: { id: cancelledStop.id },
    });
    expect(stopAfterEdit.updated_at.toISOString()).toBe(
      cancelledStop.updated_at.toISOString(),
    );

    const response = await prove(deliveryId, tappedAt);

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({
      delivery_status: "PENDING",
      late_proof: "EVIDENCE",
    });
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
        .status,
    ).toBe("PENDING");
  });
});

describe("the driver proves offline, the panel moves the status to Insucesso", () => {
  it("accepts the proof tapped before the change as Entregue", async () => {
    const { deliveryId } = await onTheStreet();
    const tappedAt = new Date(Date.now() - 5 * 60_000);

    const failed = await app.inject({
      method: "PATCH",
      url: `/delivery/update-delivery-status/${deliveryId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: { status: "FAILED", reasonId },
    });

    expect(failed.statusCode, failed.body).toBe(200);

    const response = await prove(deliveryId, tappedAt);

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({
      delivery_status: "DELIVERED",
      late_proof: "APPLIED",
    });
  });
});
