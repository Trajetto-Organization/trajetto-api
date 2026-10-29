import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The legacy departure of loose deliveries, replayed late, through the real
 * route and the real database (MOB-08).
 *
 * POST /delivery/start-route picks its deliveries when the request RUNS:
 * every PENDING delivery designated to the driver and on no route. A tap
 * queued offline and sent later would take along whatever was designated
 * since — deliveries the phone never showed, still in the warehouse. The
 * route path is safe from that because the tap names its route and the tap
 * is never dated before the route existed; this is the same rule for the
 * loose batch: the tap acts only on what existed when it was made, and a tap
 * older than the offline horizon acts on nothing.
 *
 * The phone runs two hours FAST; only the difference between its stamps
 * counts. A build that sends no time keeps today's behaviour.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;

const BUSINESS = "018fd962-0000-7000-8000-00000000000a";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PHONE_AHEAD_MS = 2 * HOUR;

let shipperId = "";

async function looseDelivery(createdAgoMs: number): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: BUSINESS,
      shipperId,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
      status: "PENDING",
      created_at: new Date(Date.now() - createdAgoMs),
    },
  });

  return delivery.id;
}

function stampedOffline(agoMs: number): {
  occurred_at: string;
  headers: Record<string, string>;
} {
  const phoneNow = Date.now() + PHONE_AHEAD_MS;

  return {
    occurred_at: new Date(phoneNow - agoMs).toISOString(),
    headers: { "x-client-sent-at": new Date(phoneNow).toISOString() },
  };
}

function startLegacy(
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/delivery/start-route/${BUSINESS}`,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    ...(body !== undefined && { payload: body }),
  });
}

const statusOf = async (deliveryId: string) =>
  (await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }))
    .status;

/** Each scenario starts from nothing loose, so none inherits another's. */
async function clearLoose(): Promise<void> {
  await prisma.delivery.updateMany({
    where: { businessId: BUSINESS, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000434",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: BUSINESS },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a legacy departure replayed after the offline horizon", () => {
  it("moves nothing, and still answers 200 so the queue lets it go", async () => {
    await clearLoose();
    const loose = await looseDelivery(HOUR);

    const { occurred_at, headers } = stampedOffline(8 * DAY);
    const response = await startLegacy({ occurred_at }, headers);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ started: 0 });
    expect(await statusOf(loose)).toBe("PENDING");
  });
});

describe("a legacy departure sent hours after the tap", () => {
  it("moves the loose deliveries that existed at the tap, and only those", async () => {
    await clearLoose();
    const seen = await looseDelivery(5 * HOUR);
    const designatedSince = await looseDelivery(HOUR);

    const { occurred_at, headers } = stampedOffline(3 * HOUR);
    const response = await startLegacy({ occurred_at }, headers);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ started: 1 });

    expect(await statusOf(seen)).toBe("IN_TRANSIT");
    expect(await statusOf(designatedSince)).toBe("PENDING");
  });
});

describe("a legacy departure from a build that sends no time", () => {
  it("moves every loose delivery, as before", async () => {
    await clearLoose();
    const older = await looseDelivery(5 * HOUR);
    const newer = await looseDelivery(60 * 1000);

    const response = await startLegacy(undefined);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ started: 2 });

    expect(await statusOf(older)).toBe("IN_TRANSIT");
    expect(await statusOf(newer)).toBe("IN_TRANSIT");
  });
});
