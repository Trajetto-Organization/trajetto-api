import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import {
  InMemoryDeliveryGeocodingRepository,
  type GeocodingRow,
} from "@/shared/delivery/geocoding/in-memory-geocoding-repository";
import { CLEARED_ADDRESS_POINT } from "@/shared/delivery/address-point";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  GEOCODING_FIXTURE as F,
  GEOCODING_NOW,
  GEOCODING_SEED,
  deliveryGeocodingContract,
  type GeocodingHarness,
  type GeocodingState,
} from "../contract/repositories/delivery-geocoding.contract";
import { KINDS, clone, type Kind } from "../contract/support";
import { seedBusiness, seedDriver, seedShipper } from "../contract/seed";

/**
 * Plan of 02/11/2026 (E1): the geocoding job's queue against Postgres and
 * the twin, plus what only Postgres can show — two runs at once never take
 * the same delivery (FOR UPDATE SKIP LOCKED), and the claim reads the
 * partial index it was written for.
 */
const prisma = createPrismaClient();
const memory = new InMemoryDeliveryGeocodingRepository();

const ADDRESS = {
  recipient_name: "Cliente",
  street: "Praça da Sé",
  address_number: "100",
  city: "São Paulo",
  uf: "SP",
};

const MANUAL_PIN = { latitude: -22.9, longitude: -43.2, geo_source: "MANUAL" };

/** The driver of the routes the open-stop claim reads (company A). */
let driverId = "";
let routeCode = 0;

function stateOf(row: Record<string, unknown> | undefined): GeocodingState {
  return {
    latitude: (row?.latitude as number | null) ?? null,
    longitude: (row?.longitude as number | null) ?? null,
    geo_source: (row?.geo_source as string | null) ?? null,
    geo_precision: (row?.geo_precision as string | null) ?? null,
    geocode_status: (row?.geocode_status as string | null) ?? null,
    geocode_attempts: (row?.geocode_attempts as number) ?? 0,
    geo_copied_from: (row?.geo_copied_from as string | null) ?? null,
  };
}

const harnesses: Record<Kind, () => GeocodingHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new DeliveryGeocodingRepository(prisma),
    async reset() {
      await prisma.routeStop.deleteMany({
        where: { route: { businessId: { in: [F.A, F.B] } } },
      });
      await prisma.route.deleteMany({
        where: { businessId: { in: [F.A, F.B] } },
      });
      await prisma.delivery.deleteMany({
        where: { businessId: { in: [F.A, F.B] } },
      });
      await prisma.delivery.createMany({
        data: GEOCODING_SEED.map((row) => ({
          ...ADDRESS,
          ...row,
          shipperId: row.businessId === F.A ? F.shipperA : F.shipperB,
        })),
      });
    },
    async read(id) {
      return stateOf(
        (await prisma.delivery.findUnique({ where: { id } })) as never,
      );
    },
    async place(id, columns) {
      await prisma.delivery.update({ where: { id }, data: columns });
    },
    async pin(id) {
      await prisma.delivery.update({
        where: { id },
        data: { ...MANUAL_PIN, geo_source: "MANUAL" },
      });
    },
    async editAddress(id) {
      await prisma.delivery.update({
        where: { id },
        data: { street: "Rua Nova", ...CLEARED_ADDRESS_POINT },
      });
    },
    async route(id) {
      routeCode += 1;

      await prisma.route.create({
        data: {
          code: routeCode,
          businessId: F.A,
          driverId,
          vehicleId: null,
          status: "RELEASED",
          released_at: GEOCODING_NOW,
          scheduled_date: new Date("2026-11-09T00:00:00.000Z"),
          stops: { create: [{ deliveryId: id, sequence: 10 }] },
        },
      });
    },
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    async reset() {
      memory.stopRoutes = [];
      memory.deliveries = clone(GEOCODING_SEED).map(
        (row) =>
          ({
            ...ADDRESS,
            neighborhood: null,
            cep: null,
            geo_precision: null,
            geo_updated_at: null,
            ...row,
          }) as GeocodingRow,
      );
    },
    async read(id) {
      return stateOf(memory.deliveries.find((row) => row.id === id) as never);
    },
    async place(id, columns) {
      Object.assign(
        memory.deliveries.find((row) => row.id === id)!,
        columns,
      );
    },
    async pin(id) {
      Object.assign(
        memory.deliveries.find((row) => row.id === id)!,
        MANUAL_PIN,
      );
    },
    async editAddress(id) {
      Object.assign(
        memory.deliveries.find((row) => row.id === id)!,
        {
          street: "Rua Nova",
          ...CLEARED_ADDRESS_POINT,
        },
      );
    },
    async route(id) {
      memory.stopRoutes.push({
        deliveryId: id,
        routeId: `route-${id}`,
        businessId: F.A,
        routeStatus: "RELEASED",
        driverUserId: null,
      });
    },
  }),
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await seedShipper(prisma, F.A, "Embarcador A", F.shipperA);
  await seedShipper(prisma, F.B, "Embarcador B", F.shipperB);

  driverId = (await seedDriver(prisma, F.A, 1)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("delivery geocoding queue (%s)", (kind) => {
  deliveryGeocodingContract(harnesses[kind]);
});

describe("delivery geocoding queue (prisma only)", () => {
  it("gives two runs at once disjoint deliveries", async () => {
    await harnesses.prisma().reset();

    const second = createPrismaClient();

    try {
      const [one, two] = await Promise.all([
        new DeliveryGeocodingRepository(prisma).claim(2, GEOCODING_NOW),
        new DeliveryGeocodingRepository(second).claim(2, GEOCODING_NOW),
      ]);

      const ids = [...one, ...two].map((claim) => claim.id);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual(
        [F.open, F.otherCompany, F.inTransit, F.failedBefore].sort(),
      );
    } finally {
      await second.$disconnect();
    }
  });

  it("claims through the partial index written for it", async () => {
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT "id" FROM "delivery"
        WHERE "latitude" IS NULL AND "geo_source" IS NULL
          AND ("geocode_status" IS NULL OR "geocode_status" = 'FAILED')
          AND "status" IN ('PENDING', 'IN_TRANSIT')
        ORDER BY "created_at" DESC LIMIT 20`,
    );

    // A tiny table may still be scanned whole; with sequential scans off the
    // planner must have the index to use.
    await prisma.$executeRawUnsafe("SET enable_seqscan = off");

    try {
      const forced = await prisma.$queryRawUnsafe<
        Array<{ "QUERY PLAN": string }>
      >(
        `EXPLAIN SELECT "id" FROM "delivery"
          WHERE "latitude" IS NULL AND "geo_source" IS NULL
            AND ("geocode_status" IS NULL OR "geocode_status" = 'FAILED')
            AND "status" IN ('PENDING', 'IN_TRANSIT')
          ORDER BY "created_at" DESC LIMIT 20`,
      );

      expect(forced.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "delivery_geocode_pending_idx",
      );
    } finally {
      await prisma.$executeRawUnsafe("SET enable_seqscan = on");
    }

    expect(plan.length).toBeGreaterThan(0);
  });
});
