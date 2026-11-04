import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { AddressPrecision } from "@/shared/services/proof-location/address-geocoder";

/**
 * The geocoding job's queue over the delivery table itself (plan of
 * 02/11/2026, E1): the open deliveries (PENDING, IN_TRANSIT) still without a
 * point and not settled by the geocoder are the queue — nothing is enqueued
 * by the create, the imports, the public API or the edit, which therefore
 * stay exactly as they were, and an address edit re-queues itself by
 * clearing the bookkeeping (CLEARED_ADDRESS_POINT).
 *
 * Multi-replica safe twice over: the cron's lease runs one replica per
 * minute, and the claim is one UPDATE over a FOR UPDATE SKIP LOCKED pick, so
 * even two runs at once take disjoint rows. The claim stamps
 * geocode_attempted_at, which is also its lease (a replica that dies frees
 * its rows after the back-off) and the token a settle must still find: an
 * address edited meanwhile cleared it, and the stale answer is dropped.
 */

/** A claimed delivery: its address, and the claim's token. */
interface GeocodingClaim {
  id: string;
  businessId: string;
  street: string | null;
  address_number: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  cep: string | null;
  /** The geocode_attempted_at this claim wrote. */
  claimedAt: Date;
  attempts: number;
}

/** What a settle writes, by outcome. */
type GeocodingSettlement =
  | {
      kind: "RESOLVED";
      latitude: number;
      longitude: number;
      precision: Extract<AddressPrecision, "ADDRESS" | "STREET">;
    }
  | {
      kind: "COARSE";
      precision: Extract<AddressPrecision, "NEIGHBORHOOD" | "CITY">;
    }
  | { kind: "NOT_FOUND" }
  | { kind: "FAILED" };

interface IDeliveryGeocodingRepository {
  /** Up to `limit` claimable deliveries, newest first, stamped `now`. */
  claim(limit: number, now: Date): Promise<GeocodingClaim[]>;

  /**
   * Writes the outcome when the claim still holds and the delivery still
   * has no point (a dispatcher's pin wins, always). True when written.
   */
  settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean>;
}

/**
 * Claims stop after this many: an address the provider failed on five times
 * is left for a person (the route map's "Fixar no mapa").
 */
const GEOCODING_MAX_ATTEMPTS = 5;

/**
 * The back-off, per attempt already made: 15 min after the first, 30 after
 * the second… Also the lease of a claim whose replica died.
 */
const GEOCODING_BACKOFF_MINUTES = 15;

class DeliveryGeocodingRepository implements IDeliveryGeocodingRepository {
  constructor(private readonly prisma = database) {}

  async claim(limit: number, now: Date): Promise<GeocodingClaim[]> {
    // The status literals and the geocode_status literal are spelled out so
    // the planner can prove delivery_geocode_pending_idx in a generic plan.
    // RETURNING keeps no order, so the claimed rows are sorted again outside.
    return this.prisma.$queryRaw<GeocodingClaim[]>`
      WITH claimed AS (
      UPDATE "delivery" AS d
      SET "geocode_attempted_at" = ${now},
          "geocode_attempts" = d."geocode_attempts" + 1
      WHERE d."id" IN (
        SELECT "id" FROM "delivery"
        WHERE "latitude" IS NULL
          AND "geo_source" IS NULL
          AND ("geocode_status" IS NULL OR "geocode_status" = 'FAILED')
          AND "status" IN ('PENDING', 'IN_TRANSIT')
          AND "geocode_attempts" < ${GEOCODING_MAX_ATTEMPTS}
          AND (
            "geocode_attempted_at" IS NULL
            OR "geocode_attempted_at" <
              ${now}::timestamp - make_interval(mins => ${GEOCODING_BACKOFF_MINUTES}::int * "geocode_attempts")
          )
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d."id", d."businessId", d."street", d."address_number",
        d."neighborhood", d."city", d."uf", d."cep", d."created_at",
        d."geocode_attempted_at" AS "claimedAt",
        d."geocode_attempts" AS "attempts"
      )
      SELECT "id", "businessId", "street", "address_number", "neighborhood",
        "city", "uf", "cep", "claimedAt", "attempts"
      FROM claimed
      ORDER BY "created_at" DESC, "id" DESC
    `;
  }

  async settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean> {
    const set = (() => {
      switch (settlement.kind) {
        case "RESOLVED":
          return Prisma.sql`
            "latitude" = ${settlement.latitude},
            "longitude" = ${settlement.longitude},
            "geo_source" = 'GEOCODER',
            "geo_updated_at" = ${now},
            "geo_precision" = ${settlement.precision}::"DeliveryGeoPrecision",
            "geocode_status" = 'RESOLVED'`;
        case "COARSE":
          return Prisma.sql`
            "geo_precision" = ${settlement.precision}::"DeliveryGeoPrecision",
            "geocode_status" = 'COARSE'`;
        case "NOT_FOUND":
          return Prisma.sql`"geocode_status" = 'NOT_FOUND'`;
        case "FAILED":
          return Prisma.sql`"geocode_status" = 'FAILED'`;
      }
    })();

    // Not a business edit: updated_at stays, so nothing that watches it
    // (the public API's updated_since) sees a change the customer did not
    // make.
    const written = await this.prisma.$executeRaw`
      UPDATE "delivery" SET ${set}
      WHERE "id" = ${claim.id}
        AND "geocode_attempted_at" = ${claim.claimedAt}
        AND "latitude" IS NULL
        AND "geo_source" IS NULL
    `;

    return written === 1;
  }
}

export {
  DeliveryGeocodingRepository,
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_MAX_ATTEMPTS,
};
export type {
  GeocodingClaim,
  GeocodingSettlement,
  IDeliveryGeocodingRepository,
};
