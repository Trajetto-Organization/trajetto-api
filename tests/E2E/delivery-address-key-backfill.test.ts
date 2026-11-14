import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { deliveryAddressKey } from "@/shared/delivery/address-key";
import { backfillDeliveryAddressKeys } from "@/shared/delivery/address-key-backfill";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedBusiness, seedShipper } from "../contract/seed";

/**
 * The owner's one-off for the deliveries written before the address key
 * (owner's report of 14/11/2026; decision D-25;
 * infra/scripts/backfill-delivery-address-key.ts runs this), against
 * Postgres: the key of every row that can have one, in batches — a stale
 * key, which the image before this one leaves when it edits an address,
 * corrected too — and each door's point given once to its open deliveries
 * still without one — the "Rua Doutor Lipold" of the report located —
 * never across companies, never over a point, never to a closed delivery,
 * never over an edit made between a batch's read and its write, and a
 * second run a no-op.
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
  // Created at number 12 by the new image, then moved to the owner's door
  // by an old replica, which does not touch the key: it still names the
  // neighbour's door.
  await seed("stale", {
    address_key: deliveryAddressKey({ ...LIPOLD, address_number: "12" }),
  });
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
      scanned: 7,
      keyed: 6,
      doors: 1,
      propagated: 2,
    });
    expect(batches).toEqual([2, 4, 6, 7]);

    const row = (name: string) =>
      prisma.delivery.findUniqueOrThrow({ where: { id: ids[name] } });

    expect((await row("pinned")).address_key).toBe(deliveryAddressKey(LIPOLD));
    expect((await row("open")).address_key).toBe(deliveryAddressKey(LIPOLD));
    expect((await row("no street")).address_key).toBeNull();
    expect((await row("stale")).address_key).toBe(deliveryAddressKey(LIPOLD));

    // The corrected key reads the right door, whose pin it now takes.
    for (const name of ["open", "stale"]) {
      expect(await row(name), name).toMatchObject({
        latitude: -22.4561,
        geo_source: "GEOCODER",
      });
    }
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
      scanned: 7,
      keyed: 0,
      doors: 0,
      propagated: 0,
    });
  });

  it("leaves alone a row edited between the batch's read and its write", async () => {
    await seed("raced", { address_number: "30", status: "DELIVERED" });

    const movedTo = { ...LIPOLD, address_number: "31" };
    let edited = false;
    // The batch has read the row at number 30; before its write, the new
    // image edits the address to number 31 and writes that key.
    const racing = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      $transaction: async (
        run: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        if (!edited) {
          edited = true;
          await prisma.delivery.update({
            where: { id: ids.raced },
            data: {
              address_number: movedTo.address_number,
              address_key: deliveryAddressKey(movedTo),
            },
          });
        }

        return prisma.$transaction(run);
      },
    } as unknown as Pick<PrismaClient, "$queryRaw" | "$transaction">;

    const report = await backfillDeliveryAddressKeys(racing);

    expect(edited).toBe(true);
    expect(report.keyed).toBe(0);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: ids.raced } }))
        .address_key,
    ).toBe(deliveryAddressKey(movedTo));
  });
});
