import { Prisma } from "@prisma/client";

import type { PointCandidate, ReusedAddressPoint } from "./address-point-reuse";

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
 *   GEOCODER, RESOLVED. updated_at stays, as with the geocoder's settle:
 *   nothing the customer edited, so the public API's updated_since does
 *   not list it. Clearing the pin later leaves these points as they are.
 */
interface AddressDoor {
  businessId: string;
  addressKey: string;
  /** The delivery the point came from: never written to. */
  exceptId: string | null;
}

/** The delivery columns the twin decides on. */
interface DoorCandidate {
  id?: string | null;
  businessId: string;
  address_key?: string | null;
  status?: string;
  latitude?: number | null;
  geo_source?: string | null;
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
 */
async function readDoorCandidates(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  door: AddressDoor,
): Promise<PointCandidate[]> {
  const atTheDoor = Prisma.sql`
    "businessId" = ${door.businessId}
      AND "address_key" = ${door.addressKey}
      AND "id" <> ${door.exceptId ?? ""}
      AND "latitude" IS NOT NULL
      AND "longitude" IS NOT NULL`;

  return client.$queryRaw<PointCandidate[]>`
    (SELECT "latitude", "longitude", "geo_source", "geo_precision",
        "geo_updated_at"
      FROM "delivery"
      WHERE ${atTheDoor}
        AND "geo_source" = 'MANUAL'
      ORDER BY "geo_updated_at" DESC NULLS LAST, "id" DESC
      LIMIT 1)
    UNION ALL
    (SELECT "latitude", "longitude", "geo_source", "geo_precision",
        "geo_updated_at"
      FROM "delivery"
      WHERE ${atTheDoor}
        AND "geo_source" = 'GEOCODER'
        AND "geo_precision" IN ('ADDRESS', 'STREET')
      ORDER BY "geo_updated_at" DESC NULLS LAST, "id" DESC
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
  // wins.
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "delivery"
    SET "latitude" = ${point.latitude},
        "longitude" = ${point.longitude},
        "geo_source" = 'GEOCODER',
        "geo_updated_at" = ${point.geo_updated_at},
        "geo_precision" = ${point.geo_precision}::"DeliveryGeoPrecision",
        "geocode_status" = 'RESOLVED'
    WHERE "businessId" = ${door.businessId}
      AND "address_key" = ${door.addressKey}
      AND "id" <> ${door.exceptId ?? ""}
      AND "status" IN ('PENDING', 'IN_TRANSIT')
      AND "latitude" IS NULL
      AND "geo_source" IS NULL
    RETURNING "id"
  `;

  return rows.map((row) => row.id);
}

export { OPEN_STATUSES, readDoorCandidates, takesDoorPoint, writePointToDoor };
export type { AddressDoor, DoorCandidate };
