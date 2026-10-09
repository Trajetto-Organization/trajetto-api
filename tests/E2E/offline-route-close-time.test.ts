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
 * When a route that closed itself finished, through the real routes and the
 * real repository (MOB-08).
 *
 * The last stop of a route can resolve through a proof or an occurrence the
 * app queued in a dead zone and sent hours later. The stop already took the
 * time of the fact; the route took the time of the upload, so a route worked
 * until 10:05 read "concluída às 13:40". The phone here runs two hours FAST:
 * only the difference between its two stamps may reach the database.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fd961-0000-7000-8000-00000000000a";

const HOUR = 60 * 60 * 1000;
const PHONE_AHEAD_MS = 2 * HOUR;

const storedKeys: string[] = [];

let shipperId = "";
let blockingTypeId = "";
let routeCode = 0;

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${BUSINESS}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

/**
 * A route already on the street, one IN_TRANSIT delivery per stop. No
 * vehicle on the route: the one-truck-one-road index would otherwise make a
 * scenario that fails to close block the next one.
 */
async function runningRoute(
  stops: number,
  startedAgoMs: number,
): Promise<{ routeId: string; deliveryIds: string[] }> {
  routeCode += 1;

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: new Date(Date.now() - startedAgoMs),
      businessId: BUSINESS,
      driverId: seed.driverId,
    },
  });

  const deliveryIds: string[] = [];

  for (let index = 0; index < stops; index += 1) {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: `Destinatário ${index + 1}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: BUSINESS,
        shipperId,
        driverId: seed.driverId,
        vehicleId: seed.vehicleId,
        status: "IN_TRANSIT",
      },
    });

    await prisma.routeStop.create({
      data: {
        routeId: route.id,
        deliveryId: delivery.id,
        sequence: (index + 1) * 10,
      },
    });

    deliveryIds.push(delivery.id);
  }

  return { routeId: route.id, deliveryIds };
}

/** What the app sends for an action tapped `agoMs` before it is sent. */
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

async function prove(deliveryId: string, agoMs?: number) {
  const stamp = agoMs === undefined ? undefined : stampedOffline(agoMs);

  const response = await app.inject({
    method: "POST",
    url: `/delivery/proof/${deliveryId}/business/${BUSINESS}`,
    headers: {
      authorization: `Bearer ${seed.driverToken}`,
      ...stamp?.headers,
    },
    payload: {
      client_submission_id: randomUUID(),
      photo: await storedPhoto(),
      ...(stamp && { occurred_at: stamp.occurred_at }),
    },
  });

  expect(response.statusCode, response.body).toBe(201);
}

const routeOf = (routeId: string) =>
  prisma.route.findUniqueOrThrow({ where: { id: routeId } });

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000353",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: BUSINESS },
    })
  ).id;

  blockingTypeId = (
    await prisma.occurrenceType.create({
      data: {
        name: "Cliente ausente",
        blocks_delivery: true,
        businessId: BUSINESS,
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

describe("a route whose last stop is proven offline", () => {
  it("finishes at the moment of the proof, not of the upload", async () => {
    const { routeId, deliveryIds } = await runningRoute(1, 5 * HOUR);

    const before = Date.now();
    await prove(deliveryIds[0], 3 * HOUR);
    const after = Date.now();

    const route = await routeOf(routeId);
    expect(route.status).toBe("COMPLETED");

    const completedAt = route.completed_at!.getTime();
    expect(completedAt).toBeGreaterThanOrEqual(before - 3 * HOUR - 1_000);
    expect(completedAt).toBeLessThanOrEqual(after - 3 * HOUR + 1_000);

    // The stop and the route tell the same hour.
    const stop = await prisma.routeStop.findFirstOrThrow({
      where: { routeId },
    });
    expect(completedAt).toBe(stop.completed_at!.getTime());
  });

  it("does not finish before a stop that was resolved later", async () => {
    // The offline proof is the LAST to arrive, not the last to happen: the
    // other stop was proven online an hour ago.
    const { routeId, deliveryIds } = await runningRoute(2, 5 * HOUR);

    await prove(deliveryIds[1]);

    const later = await prisma.routeStop.findFirstOrThrow({
      where: { routeId, deliveryId: deliveryIds[1] },
    });
    expect(later.status).toBe("COMPLETED");

    await prove(deliveryIds[0], 3 * HOUR);

    const route = await routeOf(routeId);
    expect(route.status).toBe("COMPLETED");
    expect(route.completed_at!.getTime()).toBe(later.completed_at!.getTime());
  });
});

describe("a route whose last stop fails offline", () => {
  it("finishes at the report, but never before it left", async () => {
    // Reported three hours ago on a route the database says left one hour
    // ago: a clock gone wrong somewhere, and the departure is the floor.
    const { routeId, deliveryIds } = await runningRoute(1, HOUR);
    const { occurred_at, headers } = stampedOffline(3 * HOUR);

    const response = await app.inject({
      method: "POST",
      url: `/delivery/report-occurrence/${deliveryIds[0]}/business/${BUSINESS}`,
      headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
      payload: {
        client_submission_id: randomUUID(),
        occurrenceTypeId: blockingTypeId,
        occurred_at,
      },
    });

    expect(response.statusCode, response.body).toBe(201);

    const route = await routeOf(routeId);
    expect(route.status).toBe("COMPLETED");
    expect(route.completed_at!.getTime()).toBe(route.started_at!.getTime());
  });
});

describe("a route closed by a build that sends no time", () => {
  it("keeps the receipt as the end of the route", async () => {
    const { routeId, deliveryIds } = await runningRoute(1, 5 * HOUR);

    const before = Date.now();
    await prove(deliveryIds[0]);
    const after = Date.now();

    const route = await routeOf(routeId);
    expect(route.status).toBe("COMPLETED");
    expect(route.completed_at!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(route.completed_at!.getTime()).toBeLessThanOrEqual(after + 1_000);
  });
});
