import type { Prisma, PrismaClient } from "@prisma/client";

import { deliveryAddressKey } from "./address-key";
import { pickReusablePoint } from "./geocoding/address-point-reuse";
import {
  readDoorCandidates,
  writePointToDoor,
} from "./geocoding/address-point-propagation";

/**
 * The one-off for the deliveries written before the address key (owner's
 * report of 14/11/2026; decision D-25), run by the owner once the API with
 * migration 20261114120000 serves (infra/scripts/backfill-delivery-address-key.ts):
 *
 * 1. the key of every delivery still without one, in batches by id (the
 *    primary key's order), each batch one UPDATE in its own transaction
 *    under lock_timeout — a row a create or an edit keys meanwhile is left
 *    alone (the UPDATE writes only a NULL key). The key is computed here,
 *    by the same function the create writes it with: the canonical street
 *    lives in TypeScript, not in SQL;
 * 2. the propagation, once: every open delivery without a point whose door
 *    has a point another delivery may give (a pin first, then the newest)
 *    takes it, by the same guarded write as the pin's
 *    (address-point-propagation.ts). This is what locates today's
 *    "Rua Doutor Lipold".
 *
 * Idempotent: a keyed row is skipped, and a door is written only where no
 * point is; a second run finds nothing to do. Never across companies: the
 * door is the company and the key.
 */
const BACKFILL_BATCH_SIZE = 1_000;

interface BackfillProgress {
  /** Rows without a key read so far. */
  scanned: number;
  /** Keys written so far (a row without a street or a city gets none). */
  keyed: number;
}

interface BackfillReport extends BackfillProgress {
  /** Doors that gave a point to at least one open delivery. */
  doors: number;
  /** Open deliveries that took a point. */
  propagated: number;
}

interface BackfillOptions {
  batchSize?: number;
  now?: () => Date;
  onBatch?: (progress: BackfillProgress) => void;
}

type Client = Pick<PrismaClient, "$queryRaw" | "$transaction">;

interface UnkeyedRow {
  id: string;
  street: string | null;
  address_number: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
}

/** Step 1: the key of every delivery without one. */
async function backfillAddressKeys(
  client: Client,
  { batchSize = BACKFILL_BATCH_SIZE, onBatch }: BackfillOptions = {},
): Promise<BackfillProgress> {
  const progress: BackfillProgress = { scanned: 0, keyed: 0 };
  // Keyset by id: each row is read once, and a row that gets no key (no
  // street or no city) is never read again.
  let after = "";

  for (;;) {
    const rows = await client.$queryRaw<UnkeyedRow[]>`
      SELECT "id", "street", "address_number", "neighborhood", "city", "uf"
      FROM "delivery"
      WHERE "address_key" IS NULL AND "id" > ${after}
      ORDER BY "id"
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) return progress;

    after = rows[rows.length - 1].id;
    progress.scanned += rows.length;

    const keyed = rows.flatMap((row) => {
      const key = deliveryAddressKey(row);

      return key ? [{ id: row.id, key }] : [];
    });

    if (keyed.length > 0) {
      progress.keyed += await client.$transaction(
        async (tx: Prisma.TransactionClient) => {
          // delivery is hot: a batch waits for a lock 5 s at most and fails
          // loudly instead of queueing the writes behind it.
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;

          return tx.$executeRaw`
            UPDATE "delivery" AS d
            SET "address_key" = v."key"
            FROM unnest(
              ${keyed.map((entry) => entry.id)}::text[],
              ${keyed.map((entry) => entry.key)}::text[]
            ) AS v("id", "key")
            WHERE d."id" = v."id" AND d."address_key" IS NULL
          `;
        },
      );
    }

    onBatch?.({ ...progress });
  }
}

/** Step 2: the open deliveries without a point take their door's. */
async function propagateStoredPoints(
  client: Client,
  {
    batchSize = BACKFILL_BATCH_SIZE,
    now = () => new Date(),
  }: BackfillOptions = {},
): Promise<Pick<BackfillReport, "doors" | "propagated">> {
  const report = { doors: 0, propagated: 0 };
  const tried = new Set<string>();
  let after = "";

  for (;;) {
    const rows = await client.$queryRaw<
      Array<{ id: string; businessId: string; address_key: string }>
    >`
      SELECT "id", "businessId", "address_key"
      FROM "delivery"
      WHERE "address_key" IS NOT NULL
        AND "latitude" IS NULL
        AND "geo_source" IS NULL
        AND "status" IN ('PENDING', 'IN_TRANSIT')
        AND "id" > ${after}
      ORDER BY "id"
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) return report;

    after = rows[rows.length - 1].id;

    for (const row of rows) {
      const name = `${row.businessId}|${row.address_key}`;

      if (tried.has(name)) continue;

      tried.add(name);

      const door = {
        businessId: row.businessId,
        addressKey: row.address_key,
        exceptId: null,
      };
      const point = pickReusablePoint(
        await readDoorCandidates(client, door),
        now(),
      );

      if (!point) continue;

      const written = await writePointToDoor(client, door, point);

      if (written.length > 0) {
        report.doors += 1;
        report.propagated += written.length;
      }
    }
  }
}

/** Both steps, in order. */
async function backfillDeliveryAddressKeys(
  client: Client,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const keys = await backfillAddressKeys(client, options);
  const doors = await propagateStoredPoints(client, options);

  return { ...keys, ...doors };
}

export {
  BACKFILL_BATCH_SIZE,
  backfillAddressKeys,
  backfillDeliveryAddressKeys,
  propagateStoredPoints,
};
export type { BackfillOptions, BackfillProgress, BackfillReport };
