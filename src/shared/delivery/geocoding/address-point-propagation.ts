import { Prisma } from "@prisma/client";

import { CLEARED_ADDRESS_POINT } from "../address-point";

import {
  lendingRoot,
  pickReusablePoint,
  type LenderRow,
  type PointCandidate,
  type ReusedAddressPoint,
} from "./address-point-reuse";

/**
 * A point found at one door, given to the company's other open deliveries
 * there that still have none (owner's report of 14/11/2026; decision
 * D-24): the dispatcher pins one delivery on the map ("Fixar no mapa"), and
 * the others at the same address stop reading "Sem localização". The
 * owner's backfill runs the same write once for the points already stored
 * (address-key-backfill.ts).
 *
 * - Only the company's deliveries at the same address key
 *   (address-key.ts), never the pinned one itself.
 * - Only the open ones (PENDING, IN_TRANSIT) with no point and no source,
 *   whatever their geocode_status: a NOT_FOUND or a COARSE answer is
 *   exactly the delivery a person's pin helps. Never over a point — a pin,
 *   a point given at the create, one the geocoder found — and a closed
 *   delivery keeps the record it closed with.
 * - Written as the point reuse writes it (address-point-reuse.ts):
 *   GEOCODER, RESOLVED, with the root it came from (geo_copied_from).
 *   updated_at stays, as with the geocoder's settle: nothing the customer
 *   edited, so the public API's updated_since does not list it.
 * - Only while the root still holds that point, read under FOR SHARE in
 *   the same statement (lenderHolds): a pin that moves or clears the root
 *   at the same instant either waits for this write and then finds the
 *   copy (followSource), or wins and this write gives nothing.
 *
 * A later pin on the root moves the copies with it, and clearing it clears
 * them (followSource, below): a copy follows its source while it is open,
 * still at the source's door and still holding the source's previous point.
 */
interface AddressDoor {
  businessId: string;
  addressKey: string;
  /** The delivery the point came from: never written to. */
  exceptId: string | null;
}

/** The delivery columns the twin decides on. */
interface DoorCandidate extends LenderRow {
  id?: string | null;
  businessId: string;
  address_key?: string | null;
  status?: string;
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: string | null;
  geo_precision?: string | null;
  geo_updated_at?: Date | null;
  geo_copied_from?: string | null;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set(["PENDING", "IN_TRANSIT"]);

/** Whether this delivery takes the door's point (the twin's predicate). */
function takesDoorPoint(row: DoorCandidate, door: AddressDoor): boolean {
  return (
    row.businessId === door.businessId &&
    row.address_key === door.addressKey &&
    row.id !== door.exceptId &&
    OPEN_STATUSES.has(row.status ?? "") &&
    (row.latitude ?? null) === null &&
    (row.geo_source ?? null) === null
  );
}

/**
 * The twins' readDoorCandidates: every row of the company at the door with
 * a point it may still lend (lendingRoot), the newest id first, as the SQL
 * breaks a tie of two points of one instant.
 */
function twinDoorCandidates<Row extends DoorCandidate>(
  rows: ReadonlyArray<Row>,
  door: AddressDoor,
): PointCandidate[] {
  const byId = (id: string) => rows.find((row) => row.id === id);

  return rows
    .filter(
      (row) =>
        row.businessId === door.businessId &&
        row.address_key === door.addressKey &&
        row.id !== door.exceptId &&
        typeof row.latitude === "number" &&
        typeof row.longitude === "number",
    )
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .flatMap((row): PointCandidate[] => {
      const root = lendingRoot(row, byId);

      return root === null
        ? []
        : [
            {
              latitude: row.latitude ?? null,
              longitude: row.longitude ?? null,
              geo_source: (row.geo_source ??
                null) as PointCandidate["geo_source"],
              geo_precision: row.geo_precision ?? null,
              geo_updated_at: row.geo_updated_at ?? null,
              root,
            },
          ];
    });
}

/** The twins' lenderHolds: the point's root still holds it. */
function twinLenderHolds(
  rows: ReadonlyArray<DoorCandidate>,
  businessId: string,
  point: ReusedAddressPoint,
): boolean {
  if (!point.geo_copied_from) return true;

  return rows.some(
    (row) =>
      row.id === point.geo_copied_from &&
      row.businessId === businessId &&
      row.latitude === point.latitude &&
      row.longitude === point.longitude,
  );
}

/**
 * The guard of every write of a copied point, as a condition of the write
 * itself: its root still holds the point, locked FOR SHARE until the
 * write's commit. A pin on the root takes FOR NO KEY UPDATE, which waits
 * for this lock: either the pin waits, and its follow-up finds this copy
 * and moves it; or the pin went first, and this re-reads the root's new
 * version, finds the point gone, and writes nothing — never a copy of a
 * point the root no longer has, left behind where no follow-up reaches it.
 * An uncorrelated sub-select: evaluated once, one primary-key probe.
 */
function lenderHolds(
  businessId: string,
  point: ReusedAddressPoint,
): Prisma.Sql {
  if (!point.geo_copied_from) return Prisma.sql`TRUE`;

  return Prisma.sql`EXISTS (
    SELECT 1 FROM "delivery" AS lender
    WHERE lender."id" = ${point.geo_copied_from}
      AND lender."businessId" = ${businessId}
      AND lender."latitude" = ${point.latitude}
      AND lender."longitude" = ${point.longitude}
    FOR SHARE
  )`;
}

/**
 * The same guard as its own statement, for a write Prisma builds (the
 * create's INSERT, the edit's UPDATE): run inside that write's transaction,
 * before it. True when the root still holds the point (now locked).
 */
async function lockLender(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  businessId: string,
  point: ReusedAddressPoint,
): Promise<boolean> {
  if (!point.geo_copied_from) return true;

  const rows = await client.$queryRaw<Array<{ held: number }>>`
    SELECT 1 AS "held" FROM "delivery"
    WHERE "id" = ${point.geo_copied_from}
      AND "businessId" = ${businessId}
      AND "latitude" = ${point.latitude}
      AND "longitude" = ${point.longitude}
    FOR SHARE
  `;

  return rows.length > 0;
}

/**
 * The newest point of each source at the door (a pin, the geocoder's at the
 * number or on the street), for pickReusablePoint to decide between. Shared
 * by the geocoder's claim (reusablePoint) and the owner's backfill.
 *
 * Two probes, each one LIMIT 1 down delivery_address_key_idx: its columns
 * after the door are geo_source and the newest first, the order below, so
 * each reads the first entry and stops. A DISTINCT ON over the door read
 * and sorted every point the door ever had, closed deliveries included —
 * work that grew with every delivery to a busy door. The key's equality
 * proves the index's predicate.
 *
 * Each candidate carries the root it lends as (lendingRoot, in SQL): a pin
 * is its own; a GEOCODER copy, joined to its root by the primary key, is
 * lent as that root while the root, at the same door, still holds the
 * point, and skipped once the root dropped it there; a copy whose root is
 * gone or moved away lends as its own root. In steady state the newest
 * copy's root still holds the point and the probe stops at the first
 * entry; it walks further only past copies of a point just taken away,
 * until a point found there since is newer than them.
 *
 * The join is on the root's id alone, and the company and the door are
 * compared after it: an equality between the two rows' businessId or
 * address_key would let the planner carry the door's constants over to
 * the root and look it up by delivery_address_key_idx — the whole door
 * per copy — instead of by its primary key.
 */
async function readDoorCandidates(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  door: AddressDoor,
): Promise<PointCandidate[]> {
  const atTheDoor = Prisma.sql`
    d."businessId" = ${door.businessId}
      AND d."address_key" = ${door.addressKey}
      AND d."id" <> ${door.exceptId ?? ""}
      AND d."latitude" IS NOT NULL
      AND d."longitude" IS NOT NULL`;

  return client.$queryRaw<PointCandidate[]>`
    (SELECT d."latitude", d."longitude", d."geo_source", d."geo_precision",
        d."geo_updated_at", d."id" AS "root"
      FROM "delivery" AS d
      WHERE ${atTheDoor}
        AND d."geo_source" = 'MANUAL'
      ORDER BY d."geo_updated_at" DESC NULLS LAST, d."id" DESC
      LIMIT 1)
    UNION ALL
    (SELECT d."latitude", d."longitude", d."geo_source", d."geo_precision",
        d."geo_updated_at",
        CASE
          WHEN r."businessId" = d."businessId"
            AND r."address_key" = d."address_key"
          THEN r."id"
          ELSE d."id"
        END AS "root"
      FROM "delivery" AS d
      LEFT JOIN "delivery" AS r ON r."id" = d."geo_copied_from"
      WHERE ${atTheDoor}
        AND d."geo_source" = 'GEOCODER'
        AND d."geo_precision" IN ('ADDRESS', 'STREET')
        AND (r."id" IS NULL
          OR r."businessId" <> d."businessId"
          OR r."address_key" IS DISTINCT FROM d."address_key"
          OR (r."latitude" = d."latitude" AND r."longitude" = d."longitude"))
      ORDER BY d."geo_updated_at" DESC NULLS LAST, d."id" DESC
      LIMIT 1)
  `;
}

/** Writes the point to the door's open deliveries without one; their ids. */
async function writePointToDoor(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  door: AddressDoor,
  point: ReusedAddressPoint,
): Promise<string[]> {
  // The key's equality proves delivery_address_key_idx's predicate, and
  // geo_source IS NULL is one of its conditions: the UPDATE reads the
  // door's rows without a source, not every row of the door. The status
  // literals and the two NULLs are the guards, re-checked on each row the
  // UPDATE locks, so a pin or a geocoder's settle that got there first
  // wins; lenderHolds is the root's.
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "delivery"
    SET "latitude" = ${point.latitude},
        "longitude" = ${point.longitude},
        "geo_source" = 'GEOCODER',
        "geo_updated_at" = ${point.geo_updated_at},
        "geo_precision" = ${point.geo_precision}::"DeliveryGeoPrecision",
        "geocode_status" = 'RESOLVED',
        "geo_copied_from" = ${point.geo_copied_from}
    WHERE "businessId" = ${door.businessId}
      AND "address_key" = ${door.addressKey}
      AND "id" <> ${door.exceptId ?? ""}
      AND "status" IN ('PENDING', 'IN_TRANSIT')
      AND "latitude" IS NULL
      AND "geo_source" IS NULL
      AND ${lenderHolds(door.businessId, point)}
    RETURNING "id"
  `;

  return rows.map((row) => row.id);
}

/**
 * A pin on a delivery whose point others copied (pre-push review of the
 * batch of 14/11/2026: correcting or clearing the source's pin left every
 * copy it had handed out wrong for good). In the pin's own transaction,
 * after the source's row was locked and its previous point read.
 */
interface SourcePin {
  businessId: string;
  /** The pinned delivery: the root its copies name (geo_copied_from). */
  sourceId: string;
  /** The source's address key as stored: its copies stand at this door. */
  addressKey: string;
  /** The point the source held before this pin. */
  previous: { latitude: number; longitude: number };
  /** The point its copies take now (as the reuse writes it); null clears. */
  next: ReusedAddressPoint | null;
}

/**
 * What a pin asks of the source's copies, from the source as it was before
 * the pin (read under the pin's lock) and the point pinned; null when
 * nothing follows: the source had no point (nothing of it was copied) or
 * no key (no door), or the pin wrote the point it already had ("Gravar o
 * mesmo ponto de novo é inofensivo"). The copies take the pin as the reuse
 * writes it (pickReusablePoint: GEOCODER, ADDRESS, RESOLVED, now).
 */
function sourcePinOf(
  source: {
    id: string;
    businessId: string;
    address_key: string | null;
    latitude: number | null;
    longitude: number | null;
  },
  point: { latitude: number; longitude: number } | null,
  now: Date,
): SourcePin | null {
  if (
    typeof source.latitude !== "number" ||
    typeof source.longitude !== "number" ||
    !source.address_key
  ) {
    return null;
  }

  if (
    point &&
    point.latitude === source.latitude &&
    point.longitude === source.longitude
  ) {
    return null;
  }

  return {
    businessId: source.businessId,
    sourceId: source.id,
    addressKey: source.address_key,
    previous: { latitude: source.latitude, longitude: source.longitude },
    next: point
      ? pickReusablePoint(
          [
            {
              ...point,
              geo_source: "MANUAL",
              geo_precision: null,
              geo_updated_at: now,
              root: source.id,
            },
          ],
          now,
        )
      : null,
  };
}

/** The columns a follower takes (the twins' copy of followSource's SET). */
function followerColumns(pin: SourcePin) {
  return pin.next
    ? {
        latitude: pin.next.latitude,
        longitude: pin.next.longitude,
        geo_source: "GEOCODER" as const,
        geo_updated_at: pin.next.geo_updated_at,
        geo_precision: pin.next.geo_precision,
        geocode_status: "RESOLVED" as const,
      }
    : { ...CLEARED_ADDRESS_POINT };
}

/**
 * Whether this delivery follows the source's pin (the twin's predicate):
 * the company's open copies of that source, still GEOCODER, still holding
 * exactly its previous point and still at its door. A copy a person
 * pinned since (MANUAL), one whose address changed (another key, and its
 * link cleared), a closed one (the record it closed with) and anything of
 * another company never move. A link an older image left on a row it
 * located again since holds another point, and does not move either.
 */
function followsSource(row: DoorCandidate, pin: SourcePin): boolean {
  return (
    row.businessId === pin.businessId &&
    row.geo_copied_from === pin.sourceId &&
    row.id !== pin.sourceId &&
    OPEN_STATUSES.has(row.status ?? "") &&
    row.geo_source === "GEOCODER" &&
    row.latitude === pin.previous.latitude &&
    row.longitude === pin.previous.longitude &&
    (row.address_key ?? null) === pin.addressKey
  );
}

/**
 * The copies that follow the source (followsSource) take its new point,
 * or, when the pin was cleared, lose theirs and go back to the geocoding
 * queue exactly as a fresh delivery without a point: no source, no
 * precision, no status, no attempts, no link — the job (or the lookup
 * asked right after) may then take another point of the door or ask the
 * provider. A moved copy keeps its link: the source is still its root.
 * updated_at stays, as with every write of a copy. Read down
 * delivery_geo_copied_from_idx (the status literals prove its predicate):
 * the source's open copies, not the door, locked in id order and written.
 * The door is compared with IS NOT DISTINCT FROM on purpose (the key is
 * never null here): an equality would offer the planner
 * delivery_address_key_idx too, and at a busy door — a distribution
 * centre, every closed copy GEOCODER — that index reads the whole door to
 * find the handful of open copies. The ids written.
 */
async function followSource(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  pin: SourcePin,
): Promise<string[]> {
  const set = pin.next
    ? Prisma.sql`
        "latitude" = ${pin.next.latitude},
        "longitude" = ${pin.next.longitude},
        "geo_source" = 'GEOCODER',
        "geo_updated_at" = ${pin.next.geo_updated_at},
        "geo_precision" = ${pin.next.geo_precision}::"DeliveryGeoPrecision",
        "geocode_status" = 'RESOLVED'`
    : Prisma.sql`
        "latitude" = NULL,
        "longitude" = NULL,
        "geo_source" = NULL,
        "geo_updated_at" = NULL,
        "geo_precision" = NULL,
        "geocode_status" = NULL,
        "geocode_attempted_at" = NULL,
        "geocode_attempts" = 0,
        "geo_copied_from" = NULL`;

  // Locked in id order by the sub-select (LockRows runs over its Sort),
  // then written. A bare UPDATE locks the copies in whatever order its scan
  // meets them, and two writers that take the same rows in different orders
  // deadlock; in id order, the pin queues behind a writer that also locks
  // deliveries by id (an updateMany by id IN (...) probing the primary key)
  // instead of crossing it. The order is `"id" || ''`, the same strings in
  // the same collation, on purpose: a bare ORDER BY "id" is an order that
  // delivery_businessId_id_idx gives for free, and the planner took it,
  // walking the company's deliveries with the guards as a filter, instead
  // of the handful of copies down delivery_geo_copied_from_idx and a sort.
  // The guards are checked again on each row the sub-select locks, so a
  // copy changed meanwhile is dropped, as the bare UPDATE dropped it. The
  // cycle through the source itself, locked before its copies are known,
  // is the pin's retry (RouteRepository.pinDeliveryLocation).
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "delivery" AS d
    SET ${set}
    FROM (
      SELECT "id" FROM "delivery"
      WHERE "businessId" = ${pin.businessId}
        AND "geo_copied_from" = ${pin.sourceId}
        AND "status" IN ('PENDING', 'IN_TRANSIT')
        AND "id" <> ${pin.sourceId}
        AND "geo_source" = 'GEOCODER'
        AND "latitude" = ${pin.previous.latitude}
        AND "longitude" = ${pin.previous.longitude}
        AND "address_key" IS NOT DISTINCT FROM ${pin.addressKey}
      ORDER BY "id" || ''
      FOR NO KEY UPDATE
    ) AS follower
    WHERE d."id" = follower."id"
    RETURNING d."id"
  `;

  return rows.map((row) => row.id);
}

export {
  OPEN_STATUSES,
  followSource,
  followerColumns,
  followsSource,
  lenderHolds,
  lockLender,
  readDoorCandidates,
  sourcePinOf,
  takesDoorPoint,
  twinDoorCandidates,
  twinLenderHolds,
  writePointToDoor,
};
export type { AddressDoor, DoorCandidate, SourcePin };
