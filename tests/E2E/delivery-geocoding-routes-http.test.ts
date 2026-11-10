import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import { env } from "@/env";
import { redisClientOptions } from "@/config/redis-client-options";
import { createPrismaClient } from "@/shared/database/database-client";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import {
  PAUSE_KEY,
  pauseValue,
} from "@/shared/delivery/geocoding/geocoding-gate";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * Owner's report of 09/11/2026: a delivery created with its full address
 * and put on a route showed "Sem localização" on the route page. Against
 * Postgres and over HTTP:
 *
 * - the geocoder's queue takes a routed delivery like any other — PENDING
 *   on a planned or released route, IN_TRANSIT on a running one — and
 *   claimByIds, the lookup a write starts after its commit, never reaches
 *   another company's row;
 * - a claim given back (release) is as it was, and an address edit made
 *   meanwhile makes the release a no-op;
 * - openStopRoutes names the route, its company and the driver's user only
 *   once the route is theirs, for the `routeStopsLocated` announcement;
 * - an address edit drops a point the geocoder found and queues the new
 *   address; a resend of the same address (the CEP with its hyphen) keeps
 *   it; a MANUAL pin goes with an address change (decision 14.7) and stays
 *   with any other edit;
 * - get-route answers `address_lookup` (SEARCHING, NOT_LOCATED) and never
 *   the geocoder's bookkeeping; SEARCHING only while a lookup is under way
 *   or due — not for an address nothing asked about lately, nor while the
 *   provider refuses the requests (review of 09/11/2026).
 *
 * Every claim here is claimByIds over this file's own deliveries: the E2E
 * files share a database, and the job's claim takes every company's rows.
 */
const prisma = createPrismaClient();
const queue = new DeliveryGeocodingRepository(prisma);

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let shipperId = "";
let otherShipperId = "";

const CARRIER = "018fec3a-0000-7000-8000-00000000000a";
const OTHER = "018fec3a-0000-7000-8000-00000000000b";

// The owner's example: CEP, city, UF and street; no number, no district.
const ADDRESS = {
  recipient_name: "Joaquim Ferreira",
  cep: "25610000",
  city: "Petrópolis",
  uf: "RJ",
  street: "Rua Epitácio Pessoa",
};

const FOUND = {
  latitude: -22.5084144,
  longitude: -43.1735186,
  geo_source: "GEOCODER" as const,
  geo_precision: "STREET" as const,
  geocode_status: "RESOLVED" as const,
  geocode_attempts: 1,
  geocode_attempted_at: new Date("2026-11-09T12:00:00.000Z"),
  geo_updated_at: new Date("2026-11-09T12:00:01.000Z"),
};

const MANUAL = {
  latitude: -22.509,
  longitude: -43.174,
  geo_source: "MANUAL" as const,
  geo_updated_at: new Date("2026-11-09T12:00:00.000Z"),
};

let routeCode = 0;

async function delivery(
  extra: Record<string, unknown> = {},
  businessId = CARRIER,
): Promise<string> {
  const row = await prisma.delivery.create({
    data: {
      ...ADDRESS,
      businessId,
      shipperId: businessId === CARRIER ? shipperId : otherShipperId,
      ...extra,
    },
  });

  return row.id;
}

async function route(
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED",
  stops: Array<{ deliveryId: string; status?: "PENDING" | "COMPLETED" }>,
): Promise<string> {
  routeCode += 1;

  const created = await prisma.route.create({
    data: {
      code: routeCode,
      businessId: CARRIER,
      driverId: carrier.driverId,
      // No vehicle: one running route per vehicle is a database rule this
      // file does not need to meet.
      vehicleId: null,
      status,
      scheduled_date: new Date("2026-11-09"),
      released_at: status === "PLANNED" ? null : new Date(),
      started_at:
        status === "IN_PROGRESS" || status === "COMPLETED" ? new Date() : null,
      completed_at: status === "COMPLETED" ? new Date() : null,
      stops: {
        create: stops.map((stop, index) => ({
          deliveryId: stop.deliveryId,
          sequence: (index + 1) * 10,
          status: stop.status ?? "PENDING",
        })),
      },
    },
  });

  return created.id;
}

const geocoding = (id: string) =>
  prisma.delivery.findUniqueOrThrow({
    where: { id },
    select: {
      latitude: true,
      longitude: true,
      geo_source: true,
      geo_precision: true,
      geo_updated_at: true,
      geocode_status: true,
      geocode_attempted_at: true,
      geocode_attempts: true,
    },
  });

const edit = (deliveryId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "PATCH",
    url: `/delivery/update-delivery/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.managerToken}` },
    payload: body,
  });

const claimedIds = async (ids: string[], businessId = CARRIER) =>
  (await queue.claimByIds(ids, businessId, 100, new Date())).map(
    (claim) => claim.id,
  );

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667003000108",
  });
  await seedFleetDriver(prisma, { businessId: OTHER, cnpj: "55667003000280" });

  shipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
    })
  ).id;
  otherShipperId = (
    await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID()}`, businessId: OTHER },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the geocoder's queue and the routes", () => {
  it("claims a routed delivery like any other: planned, released and running routes", async () => {
    const unrouted = await delivery();
    const planned = await delivery();
    const released = await delivery();
    const running = await delivery({ status: "IN_TRANSIT" });
    const delivered = await delivery({ status: "DELIVERED" });

    await route("PLANNED", [{ deliveryId: planned }]);
    await route("RELEASED", [{ deliveryId: released }]);
    await route("IN_PROGRESS", [
      { deliveryId: running },
      { deliveryId: delivered, status: "COMPLETED" },
    ]);

    const claimed = await claimedIds([
      unrouted,
      planned,
      released,
      running,
      delivered,
    ]);

    expect(claimed.sort()).toEqual(
      [unrouted, planned, released, running].sort(),
    );
  });

  it("never reaches another company's delivery through claimByIds", async () => {
    const theirs = await delivery({}, OTHER);

    expect(await claimedIds([theirs])).toEqual([]);
    expect((await geocoding(theirs)).geocode_attempts).toBe(0);

    expect(await claimedIds([theirs], OTHER)).toEqual([theirs]);
  });

  it("gives a claim back as it was, and not after an address edit cleared it", async () => {
    const kept = await delivery();
    const edited = await delivery();

    const claims = await queue.claimByIds(
      [kept, edited],
      CARRIER,
      10,
      new Date(),
    );
    const claimOf = (id: string) => claims.find((claim) => claim.id === id)!;

    expect(await queue.release(claimOf(kept))).toBe(true);
    expect(await geocoding(kept)).toMatchObject({
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });

    const response = await edit(edited, { street: "Rua do Imperador" });

    expect(response.statusCode, response.body).toBe(200);
    expect(await queue.release(claimOf(edited))).toBe(false);
    expect(await geocoding(edited)).toMatchObject({
      geocode_status: null,
      geocode_attempts: 0,
      geocode_attempted_at: null,
    });

    // Both are claimable again at once.
    expect((await claimedIds([kept, edited])).sort()).toEqual(
      [kept, edited].sort(),
    );
  });

  it("names the open stops' routes, and the driver only once the route is theirs", async () => {
    const onPlanned = await delivery();
    const onReleased = await delivery();
    const onCompleted = await delivery({ status: "DELIVERED" });

    const plannedId = await route("PLANNED", [{ deliveryId: onPlanned }]);
    const releasedId = await route("RELEASED", [{ deliveryId: onReleased }]);
    await route("COMPLETED", [
      { deliveryId: onCompleted, status: "COMPLETED" },
    ]);

    const stops = await queue.openStopRoutes([
      onPlanned,
      onReleased,
      onCompleted,
    ]);

    expect(
      stops.sort((a, b) => a.routeStatus.localeCompare(b.routeStatus)),
    ).toEqual([
      {
        deliveryId: onPlanned,
        routeId: plannedId,
        businessId: CARRIER,
        routeStatus: "PLANNED",
        driverUserId: null,
      },
      {
        deliveryId: onReleased,
        routeId: releasedId,
        businessId: CARRIER,
        routeStatus: "RELEASED",
        driverUserId: carrier.driverUserId,
      },
    ]);
  });
});

describe("an address edit", () => {
  it("drops a point the geocoder found and queues the new address", async () => {
    const id = await delivery(FOUND);

    const response = await edit(id, { street: "Rua do Imperador" });

    expect(response.statusCode, response.body).toBe(200);
    expect(await geocoding(id)).toEqual({
      latitude: null,
      longitude: null,
      geo_source: null,
      geo_precision: null,
      geo_updated_at: null,
      geocode_status: null,
      geocode_attempted_at: null,
      geocode_attempts: 0,
    });
    expect(await claimedIds([id])).toEqual([id]);
  });

  it("keeps the point when the form resends the same address, the CEP with its hyphen", async () => {
    const id = await delivery(FOUND);

    const response = await edit(id, {
      ...ADDRESS,
      cep: "25610-000",
      notes: "Portão azul",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await geocoding(id)).toMatchObject({
      latitude: FOUND.latitude,
      geo_source: "GEOCODER",
      geocode_status: "RESOLVED",
      geocode_attempts: 1,
    });
  });

  it("keeps a MANUAL pin through any other edit, and clears it with the address (decision 14.7)", async () => {
    const id = await delivery(MANUAL);

    const notes = await edit(id, { notes: "Interfone 12" });

    expect(notes.statusCode, notes.body).toBe(200);
    expect(await geocoding(id)).toMatchObject({
      latitude: MANUAL.latitude,
      geo_source: "MANUAL",
    });

    const moved = await edit(id, { street: "Rua do Imperador" });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(await geocoding(id)).toMatchObject({
      latitude: null,
      geo_source: null,
      geocode_status: null,
    });
    expect(await claimedIds([id])).toEqual([id]);
  });
});

/** get-route as the carrier's manager, with the lookups switched on. */
async function readRoute(routeId: string) {
  const saved = env.REVERSE_GEOCODER_URL;

  // On for the read only: with it on, a write would also start a lookup.
  env.REVERSE_GEOCODER_URL = "http://127.0.0.1:9";

  try {
    return await app.inject({
      method: "GET",
      url: `/route/get-route/${routeId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });
  } finally {
    env.REVERSE_GEOCODER_URL = saved;
  }
}

describe("get-route's address_lookup", () => {
  it("promises nothing for an address nothing asked about lately", async () => {
    const forgotten = await delivery();

    // The row's last write half an hour ago; raw, so @updatedAt stays out.
    await prisma.$executeRaw`
      UPDATE "delivery" SET "updated_at" = now() - interval '30 minutes'
      WHERE "id" = ${forgotten}`;

    const routeId = await route("PLANNED", [{ deliveryId: forgotten }]);
    const response = await readRoute(routeId);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.stops[0].delivery.address_lookup).toBeNull();
    expect(response.json().data.stops[0].delivery).not.toHaveProperty(
      "updated_at",
    );
  });

  it("promises nothing while the provider refuses the requests", async () => {
    const fresh = await delivery();
    const routeId = await route("PLANNED", [{ deliveryId: fresh }]);

    const redis = new Redis(
      process.env.REDIS_URL!,
      redisClientOptions("geocoding-budget"),
    );

    try {
      expect(
        (await readRoute(routeId)).json().data.stops[0].delivery,
      ).toMatchObject({ address_lookup: "SEARCHING" });

      // The pause a refusal writes; a few seconds only, as Redis is shared
      // by the E2E files running beside this one.
      await redis.set(
        PAUSE_KEY,
        pauseValue("REFUSED", new Date(Date.now() + 5_000)),
        "PX",
        5_000,
      );

      const response = await readRoute(routeId);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.stops[0].delivery.address_lookup).toBeNull();
    } finally {
      await redis.del(PAUSE_KEY);
      await redis.quit();
    }
  });

  it("tells a stop being looked up from one not located, and answers no bookkeeping", async () => {
    const searching = await delivery();
    const notLocated = await delivery({
      geocode_status: "NOT_FOUND",
      geocode_attempts: 1,
      geocode_attempted_at: new Date(),
    });
    const pinned = await delivery(MANUAL);

    const routeId = await route("PLANNED", [
      { deliveryId: searching },
      { deliveryId: notLocated },
      { deliveryId: pinned },
    ]);

    const saved = env.REVERSE_GEOCODER_URL;

    // On for the read only: with it on, a write would also start a lookup.
    env.REVERSE_GEOCODER_URL = "http://127.0.0.1:9";

    let response;

    try {
      response = await app.inject({
        method: "GET",
        url: `/route/get-route/${routeId}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${carrier.managerToken}` },
      });
    } finally {
      env.REVERSE_GEOCODER_URL = saved;
    }

    expect(response.statusCode, response.body).toBe(200);

    const stops = response.json().data.stops as Array<{
      delivery: Record<string, unknown>;
    }>;
    const lookupOf = (id: string) =>
      stops.find((stop) => stop.delivery.id === id)?.delivery.address_lookup;

    expect(lookupOf(searching)).toBe("SEARCHING");
    expect(lookupOf(notLocated)).toBe("NOT_LOCATED");
    expect(lookupOf(pinned)).toBeNull();

    for (const stop of stops) {
      expect(stop.delivery).not.toHaveProperty("geocode_status");
      expect(stop.delivery).not.toHaveProperty("geocode_attempts");
    }
  });

  it("says nothing on a server that looks nothing up", async () => {
    const plain = await delivery();
    const routeId = await route("PLANNED", [{ deliveryId: plain }]);

    const saved = env.REVERSE_GEOCODER_URL;

    env.REVERSE_GEOCODER_URL = undefined;

    let response;

    try {
      response = await app.inject({
        method: "GET",
        url: `/route/get-route/${routeId}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${carrier.managerToken}` },
      });
    } finally {
      env.REVERSE_GEOCODER_URL = saved;
    }

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.stops[0].delivery.address_lookup).toBeNull();
  });
});
