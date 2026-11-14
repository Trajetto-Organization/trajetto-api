import { Prisma, type PrismaClient } from "@prisma/client";

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
 * 1. the key of every delivery, recomputed, in batches by id (the primary
 *    key's order), each batch one UPDATE in its own transaction under
 *    lock_timeout, written only where the stored key differs. That fills
 *    the rows still without one and corrects a stale one: the image before
 *    this one edits an address without touching the key — an old replica
 *    during the rollout, every edit after a rollback past this image — so
 *    a delivery kept its old door's key while it got its new door's point,
 *    and later creates at the old door copied that point. The key is
 *    computed here, by the same function the create writes it with: the
 *    canonical street lives in TypeScript, not in SQL;
 * 2. the propagation, once: every open delivery without a point whose door
 *    has a point another delivery may give (a pin first, then the newest)
 *    takes it, by the same guarded write as the pin's
 *    (address-point-propagation.ts). This is what locates today's
 *    "Rua Doutor Lipold".
 *
 * A row edited between the batch's read and its write is left alone: the
 * UPDATE also asks for the address and the key the batch read (the
 * address as a digest, ADDRESS_DIGEST), so the edit's own key wins — and a
 * row an older image edited meanwhile waits for the next run instead of
 * taking the key of its previous address.
 *
 * Idempotent: a row whose key is right is not written, and a door is
 * written only where no point is; a second run reads every row and writes
 * nothing. Never across companies: the door is the company and the key.
 */
const BACKFILL_BATCH_SIZE = 1_000;

interface BackfillProgress {
  /** Rows read so far: every delivery, once. */
  scanned: number;
  /**
   * Keys written so far: the ones that were missing and the stale ones
   * (a row without a street or a city gets none).
   */
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

interface KeyedRow {
  id: string;
  street: string | null;
  address_number: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  address_key: string | null;
  /** ADDRESS_DIGEST, as read. */
  digest: string;
}

/**
 * The address a key is computed from, as one value the write can compare:
 * %L quotes a text and spells NULL bare, so a NULL and an empty street are
 * two digests, and the arrays the UPDATE takes carry no NULL.
 */
const ADDRESS_DIGEST = Prisma.sql`md5(format('%L|%L|%L|%L|%L',
  d."street", d."address_number", d."neighborhood", d."city", d."uf"))`;

/** Step 1: the key of every delivery, written where it is missing or stale. */
async function backfillAddressKeys(
  client: Client,
  { batchSize = BACKFILL_BATCH_SIZE, onBatch }: BackfillOptions = {},
): Promise<BackfillProgress> {
  const progress: BackfillProgress = { scanned: 0, keyed: 0 };
  // Keyset by id: each row is read once.
  let after = "";

  for (;;) {
    const rows = await client.$queryRaw<KeyedRow[]>`
      SELECT d."id", d."street", d."address_number", d."neighborhood",
        d."city", d."uf", d."address_key", ${ADDRESS_DIGEST} AS "digest"
      FROM "delivery" AS d
      WHERE d."id" > ${after}
      ORDER BY d."id"
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) return progress;

    after = rows[rows.length - 1].id;
    progress.scanned += rows.length;

    // '' stands for "no key" in the arrays: a key is 64 hex characters.
    const changed = rows.flatMap((row) => {
      const key = deliveryAddressKey(row);

      return key === row.address_key
        ? []
        : [
            {
              id: row.id,
              key: key ?? "",
              was: row.address_key ?? "",
              digest: row.digest,
            },
          ];
    });

    if (changed.length > 0) {
      progress.keyed += await client.$transaction(
        async (tx: Prisma.TransactionClient) => {
          // delivery is hot: a batch waits for a lock 5 s at most and fails
          // loudly instead of queueing the writes behind it.
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;

          return tx.$executeRaw`
            UPDATE "delivery" AS d
            SET "address_key" = NULLIF(v."key", '')
            FROM unnest(
              ${changed.map((entry) => entry.id)}::text[],
              ${changed.map((entry) => entry.key)}::text[],
              ${changed.map((entry) => entry.was)}::text[],
              ${changed.map((entry) => entry.digest)}::text[]
            ) AS v("id", "key", "was", "digest")
            WHERE d."id" = v."id"
              AND d."address_key" IS NOT DISTINCT FROM NULLIF(v."was", '')
              AND ${ADDRESS_DIGEST} = v."digest"
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
