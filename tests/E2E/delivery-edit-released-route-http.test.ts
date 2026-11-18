import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Editing a delivery the driver already has (K9), through the real route,
 * transaction and outbox.
 *
 * The office fixed the address of a delivery on a released route and nothing
 * told the phone: the plan version stayed, so the app kept the old address,
 * and no push went out. Now the edit locks the route, moves its plan version
 * and writes the trail's line in one commit, and the driver's push
 * (`route.plan_changed`, keyed by the new version) is queued after it.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let otherManagerToken = "";
let shipperId = "";

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

let routeCode = 0;

async function deliveryOnRoute(
  status: "PLANNED" | "RELEASED",
): Promise<{ deliveryId: string; routeId: string }> {
  routeCode += 1;

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      recipient_telephone: "11999990000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      address_number: "10",
      latitude: -23.55,
      longitude: -46.63,
      geo_source: "MANUAL",
      businessId: CARRIER,
      shipperId,
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
      status,
      scheduled_date: new Date("2026-11-03"),
      plan_version: 2,
      released_at: status === "RELEASED" ? new Date() : null,
      stops: { create: { deliveryId: delivery.id, sequence: 10 } },
    },
  });

  return { deliveryId: delivery.id, routeId: route.id };
}

const edit = (
  deliveryId: string,
  body: Record<string, unknown>,
  token = carrier.managerToken,
  businessId = CARRIER,
) =>
  app.inject({
    method: "PATCH",
    url: `/delivery/update-delivery/${deliveryId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667002000191",
  });

  await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55667002000272",
  });
  otherManagerToken = (await seedUser(prisma, OTHER, "BUSINESS_ADMIN")).token;

  shipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("an edit to a delivery on a released route", () => {
  it("moves the plan, writes the line and queues the driver's push, in one commit", async () => {
    const { deliveryId, routeId } = await deliveryOnRoute("RELEASED");

    const response = await edit(deliveryId, {
      street: "Rua Dois",
      recipient_telephone: "11988887777",
    });

    expect(response.statusCode, response.body).toBe(200);

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    expect(route.plan_version).toBe(3);

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    // The old pin pointed at the old address.
    expect(delivery).toMatchObject({
      street: "Rua Dois",
      latitude: null,
      longitude: null,
    });

    const lines = await prisma.deliveryEvent.findMany({
      where: { deliveryId, type: "NOTE" },
    });

    expect(lines).toEqual([
      expect.objectContaining({
        routeId,
        actor: "USER",
        businessId: CARRIER,
        note: "Dados alterados no painel: endereço e telefone.",
      }),
    ]);

    const push = await prisma.domainOutboxEvent.findFirst({
      where: { eventKey: `route:${routeId}:plan:3` },
    });

    expect(push).toMatchObject({ topic: "route.plan_changed" });
    expect(push?.payload).toMatchObject({
      routeId,
      planVersion: 3,
      driverUserId: carrier.driverUserId,
    });
  });

  it("moves nothing when the form resends the values it had", async () => {
    const { deliveryId, routeId } = await deliveryOnRoute("RELEASED");

    const response = await edit(deliveryId, {
      street: "Rua Um",
      recipient_name: "Mercado Central",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .plan_version,
    ).toBe(2);
    expect(
      await prisma.deliveryEvent.count({ where: { deliveryId, type: "NOTE" } }),
    ).toBe(0);
  });

  it("moves a planned route's version without pushing anybody", async () => {
    const { deliveryId, routeId } = await deliveryOnRoute("PLANNED");

    const response = await edit(deliveryId, { notes: "Portão azul" });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .plan_version,
    ).toBe(3);
    expect(
      await prisma.domainOutboxEvent.count({
        where: { eventKey: `route:${routeId}:plan:3` },
      }),
    ).toBe(0);
  });

  it("answers another company's dispatcher like a missing delivery, and moves nothing", async () => {
    const { deliveryId, routeId } = await deliveryOnRoute("RELEASED");

    const response = await edit(
      deliveryId,
      { street: "Rua Alheia" },
      otherManagerToken,
      OTHER,
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .plan_version,
    ).toBe(2);
  });
});
