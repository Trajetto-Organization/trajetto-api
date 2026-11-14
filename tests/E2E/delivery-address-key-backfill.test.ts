import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { deliveryAddressKey } from "@/shared/delivery/address-key";
import { backfillDeliveryAddressKeys } from "@/shared/delivery/address-key-backfill";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedBusiness, seedShipper } from "../contract/seed";

/**
 * The owner's one-off for the deliveries written before the address key
 * (owner's report of 14/11/2026; decision D-25;
 * infra/scripts/backfill-delivery-address-key.ts runs this), against
 * Postgres: the key of every row that can have one, in batches, and each
 * door's point given once to its open deliveries still without one — the
 * "Rua Doutor Lipold" of the report located — never across companies, never
 * over a point, never to a closed delivery, and a second run a no-op.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdc90-0000-7000-8000-00000000000a";
const OTHER = "018fdc90-0000-7000-8000-00000000000b";
const SHIPPER = "018fdc90-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fdc90-0000-7000-8000-0000000000f2";

const LIPOLD = {
  street: "Rua Doutor Lipold",
  address_number: "10",
  neighborhood: "Carangola",
  city: "Petrópolis",
  uf: "RJ",
};

const ids: Record<string, string> = {};

async function seed(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  ids[name] = randomUUID();

  // Straight into the table, without a key: what the rows written before
  // the migration look like.
  await prisma.delivery.create({
    data: {
      id: ids[name],
      ...LIPOLD,
      recipient_name: name,
      businessId: CARRIER,
      shipperId: SHIPPER,
      ...extra,
    },
  });
}

beforeAll(async () => {
  await seedBusiness(prisma, CARRIER, 1);
  await seedBusiness(prisma, OTHER, 2);
  await seedShipper(prisma, CARRIER, "Embarcador", SHIPPER);
  await seedShipper(prisma, OTHER, "Embarcador da outra", OTHER_SHIPPER);

  // The pin the dispatcher made on the first delivery at the door.
  await seed("pinned", {
    latitude: -22.4561,
    longitude: -43.1702,
    geo_source: "MANUAL",
    geo_updated_at: new Date("2026-11-13T10:00:00.000Z"),
  });
  await seed("open", { street: "R. Dr. Lipold", geocode_status: "FAILED" });
  await seed("delivered", { status: "DELIVERED" });
  await seed("neighbour", { address_number: "12" });
  await seed("elsewhere", { businessId: OTHER, shipperId: OTHER_SHIPPER });
  await seed("no street", { street: "" });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the address key's backfill", () => {
  it("keys every row that can have a key, then gives each door's point to its open deliveries", async () => {
    const batches: number[] = [];

    const report = await backfillDeliveryAddressKeys(prisma, {
      batchSize: 2,
      onBatch: ({ scanned }) => batches.push(scanned),
    });

    expect(report).toEqual({
      scanned: 6,
      keyed: 5,
      doors: 1,
      propagated: 1,
    });
    expect(batches).toEqual([2, 4, 6]);

    const row = (name: string) =>
      prisma.delivery.findUniqueOrThrow({ where: { id: ids[name] } });

    expect((await row("pinned")).address_key).toBe(deliveryAddressKey(LIPOLD));
    expect((await row("open")).address_key).toBe(deliveryAddressKey(LIPOLD));
    expect((await row("no street")).address_key).toBeNull();

    expect(await row("open")).toMatchObject({
      latitude: -22.4561,
      longitude: -43.1702,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
    });
    expect(await row("pinned")).toMatchObject({ geo_source: "MANUAL" });

    for (const name of ["delivered", "neighbour", "elsewhere"]) {
      expect(await row(name), name).toMatchObject({
        latitude: null,
        geo_source: null,
      });
    }
  });

  it("finds nothing to do the second time", async () => {
    expect(await backfillDeliveryAddressKeys(prisma)).toEqual({
      scanned: 1,
      keyed: 0,
      doors: 0,
      propagated: 0,
    });
  });
});
