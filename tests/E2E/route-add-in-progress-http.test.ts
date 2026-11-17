import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";
import { withStatusTrail } from "../support/status-trail";

/**
 * Adding to a running route and "Reentregar" (K12, decision D30), through
 * the real route, transaction and outbox.
 *
 * "Adicionar entregas" was refused once the route left (409). Now the stop
 * joins at the end, the load is on the street in the same commit (the app's
 * arrival and proof need IN_TRANSIT), the person waiting is told it left and
 * the driver's push for the new plan is queued. "Reentregar" puts a failed
 * delivery back to pending with the reason and on the route, atomically.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let otherManagerToken = "";
let shipperId = "";
let reasonId = "";
let foreignReasonId = "";

const CARRIER = "018fe210-0000-7000-8000-00000000000a";
const OTHER = "018fe210-0000-7000-8000-00000000000b";

let routeCode = 0;

async function seedDelivery(
  status: "PENDING" | "FAILED" = "PENDING",
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      recipient_telephone: "11999990000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      businessId: CARRIER,
      shipperId,
      status,
    },
  });

  return delivery.id;
}

async function runningRoute(): Promise<string> {
  routeCode += 1;

  // One running route per driver and per truck (partial unique indexes):
  // the previous test's route ends first.
  await prisma.route.updateMany({
    where: { businessId: CARRIER, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completed_at: new Date() },
  });

  const onBoard = await seedDelivery();

  await prisma.delivery.update({
    where: { id: onBoard },
    data: {
      status: "IN_TRANSIT",
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
    },
  });

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      businessId: CARRIER,
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
      status: "IN_PROGRESS",
      scheduled_date: new Date("2026-11-03"),
      released_at: new Date(),
      started_at: new Date(),
      plan_version: 1,
      stops: { create: { deliveryId: onBoard, sequence: 10 } },
    },
  });

  return route.id;
}

const addStops = (
  routeId: string,
  body: Record<string, unknown>,
  token = carrier.managerToken,
  businessId = CARRIER,
) =>
  app.inject({
    method: "POST",
    url: `/route/add-stops/${routeId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const refusal = (response: {
  statusCode: number;
  json: () => { code?: string };
}) => `${response.statusCode} ${response.json().code}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667003000191",
  });

  await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55667003000272",
  });
  otherManagerToken = (await seedUser(prisma, OTHER, "BUSINESS_ADMIN")).token;

  shipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
    })
  ).id;

  reasonId = (
    await prisma.statusChangeReason.create({
      data: { name: "Cliente pediu nova tentativa", businessId: CARRIER },
    })
  ).id;

  foreignReasonId = (
    await prisma.statusChangeReason.create({
      data: { name: "Motivo alheio", businessId: OTHER },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("adding to a route in progress", () => {
  it("puts the delivery on the street, tells the customer and queues the driver's push", async () => {
    const routeId = await runningRoute();
    const late = await seedDelivery();

    const response = await addStops(routeId, {
      deliveryIds: [late],
      expectedPlanVersion: 1,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ added: 1, planVersion: 2 });

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: late },
    });

    expect(delivery).toMatchObject({
      status: "IN_TRANSIT",
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
    });

    const stop = await prisma.routeStop.findFirstOrThrow({
      where: { deliveryId: late },
    });

    expect(stop).toMatchObject({ routeId, status: "PENDING", sequence: 20 });

    const dispatched = await prisma.domainOutboxEvent.count({
      where: { topic: "delivery.dispatched", aggregateId: late },
    });

    expect(dispatched).toBe(1);

    const push = await prisma.domainOutboxEvent.findUnique({
      where: { eventKey: `route:${routeId}:plan:2` },
    });

    expect(push).toMatchObject({ topic: "route.plan_changed" });
  });

  it("answers another company's dispatcher like a missing route, adding nothing", async () => {
    const routeId = await runningRoute();
    const late = await seedDelivery();

    const response = await addStops(
      routeId,
      { deliveryIds: [late] },
      otherManagerToken,
      OTHER,
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(await prisma.routeStop.count({ where: { deliveryId: late } })).toBe(
      0,
    );
  });

  it("refuses a route that ended", async () => {
    const routeId = await runningRoute();

    await prisma.route.update({
      where: { id: routeId },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    const response = await addStops(routeId, {
      deliveryIds: [await seedDelivery()],
    });

    expect(refusal(response), response.body).toBe("409 ROUTE_STATUS_CONFLICT");
  });
});

describe("Reentregar", () => {
  // The departure's SYSTEM line is asserted below (F2-06).
  withStatusTrail();

  it("puts a failed delivery back with the reason and on the running route, in one transaction", async () => {
    const routeId = await runningRoute();
    const failed = await seedDelivery("FAILED");

    const response = await addStops(routeId, {
      deliveryIds: [failed],
      redelivery: { reasonId, note: "Cliente ligou" },
    });

    expect(response.statusCode, response.body).toBe(201);

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: failed } }))
        .status,
    ).toBe("IN_TRANSIT");

    const lines = await prisma.deliveryEvent.findMany({
      where: { deliveryId: failed, type: "STATUS_CHANGE" },
    });

    // The redelivery by the dispatcher, and the departure on the running
    // route by itself (F2-06), in the same commit: the same instant, so in
    // no order the ids can promise.
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status_from: "FAILED",
          status_to: "PENDING",
          reasonId,
          note: "Cliente ligou",
        }),
        expect.objectContaining({
          status_from: "PENDING",
          status_to: "IN_TRANSIT",
          actor: "SYSTEM",
          routeId,
        }),
      ]),
    );
  });

  it("does not show the new stop the previous attempt's answer on the driver's card", async () => {
    // Red before: my-deliveries returned the driver's newest request for
    // the delivery, whatever attempt it was for, so the redelivered stop
    // showed "Autorizado…" from the APPROVED report that left it FAILED.
    const routeId = await runningRoute();
    const failed = await seedDelivery("FAILED");

    const towerType = await prisma.occurrenceType.create({
      data: {
        name: `Cliente ausente ${randomUUID().slice(0, 6)}`,
        businessId: CARRIER,
        blocks_delivery: true,
        requires_authorization: true,
      },
    });

    const askTheTower = (createdAt?: Date) =>
      prisma.deliveryOccurrence.create({
        data: {
          deliveryId: failed,
          businessId: CARRIER,
          occurrenceTypeId: towerType.id,
          reportedById: carrier.driverUserId,
          authorization_status: createdAt ? "APPROVED" : "PENDING",
          ...(createdAt && { created_at: createdAt, authorized_at: createdAt }),
        },
      });

    // The previous attempt: approved, which is what left it FAILED.
    await askTheTower(new Date(Date.now() - 60 * 60 * 1000));

    const response = await addStops(routeId, {
      deliveryIds: [failed],
      redelivery: { reasonId },
    });

    expect(response.statusCode, response.body).toBe(201);

    const cardOf = async () => {
      const day = await app.inject({
        method: "GET",
        url: `/delivery/my-deliveries/${CARRIER}`,
        headers: { authorization: `Bearer ${carrier.driverToken}` },
      });

      expect(day.statusCode, day.body).toBe(200);

      return (
        day.json().data as Array<{
          id: string;
          authorization_request: {
            occurrenceId: string;
            status: string;
          } | null;
        }>
      ).find((entry) => entry.id === failed);
    };

    const card = await cardOf();

    expect(card).toBeDefined();
    expect(card?.authorization_request).toBeNull();

    // What the driver asks on this attempt is shown.
    const current = await askTheTower();

    expect((await cardOf())?.authorization_request).toMatchObject({
      occurrenceId: current.id,
      status: "PENDING",
    });
  });

  it("refuses another company's reason like a missing one, and writes nothing", async () => {
    const routeId = await runningRoute();
    const failed = await seedDelivery("FAILED");

    const response = await addStops(routeId, {
      deliveryIds: [failed],
      redelivery: { reasonId: foreignReasonId },
    });

    expect(refusal(response), response.body).toBe(
      "404 STATUS_CHANGE_REASON_NOT_FOUND",
    );
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: failed } }))
        .status,
    ).toBe("FAILED");
  });

  it("still refuses a failed delivery sent without a reason", async () => {
    const routeId = await runningRoute();

    const response = await addStops(routeId, {
      deliveryIds: [await seedDelivery("FAILED")],
    });

    expect(refusal(response), response.body).toBe("400 DELIVERY_NOT_ROUTABLE");
  });
});
