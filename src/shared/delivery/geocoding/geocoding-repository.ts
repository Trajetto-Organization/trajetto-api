import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { AddressPrecision } from "@/shared/services/proof-location/address-geocoder";
import {
  OPEN_STOP_STATUSES,
  type RouteStatus,
} from "@/shared/route/route-rules";
import { deliveryAddressKey } from "@/shared/delivery/address-key";

import {
  pickReusablePoint,
  type ReusedAddressPoint,
} from "./address-point-reuse";
import { lenderHolds, readDoorCandidates } from "./address-point-propagation";

import {
  GEOCODING_BACKOFF_CAP_MINUTES,
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_MAX_ATTEMPTS,
  geocodingBackoffMinutes,
} from "./geocoding-rules";

/**
 * The geocoding job's queue over the delivery table itself (plan of
 * 02/11/2026, E1): the open deliveries (PENDING, IN_TRANSIT) still without a
 * point and not settled by the geocoder are the queue — nothing is enqueued
 * by the create, the imports, the public API or the edit, which therefore
 * stay exactly as they were, and an address edit re-queues itself by
 * clearing the bookkeeping (CLEARED_ADDRESS_POINT). A delivery on a planned
 * or released route is still PENDING, and one on a running route is
 * IN_TRANSIT: a routed delivery is in the queue like any other.
 *
 * Multi-replica safe twice over: the cron's lease runs one replica per
 * minute, and the claim is one UPDATE over a FOR UPDATE SKIP LOCKED pick, so
 * even two runs at once take disjoint rows — the cron's and the lookup a
 * request starts after its commit (claimByIds, geocode-soon.ts) included.
 * The claim stamps geocode_attempted_at, which is also its lease (a replica
 * that dies frees its rows after the back-off) and the token a settle must
 * still find: an address edited meanwhile cleared it, and the stale answer
 * is dropped.
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
  /**
   * The geocode_attempted_at before this claim: what a release puts back,
   * so a claim the provider never answered about costs the delivery no
   * attempt and no back-off.
   */
  previousAttemptedAt: Date | null;
}

/** What a settle writes, by outcome. */
type GeocodingSettlement =
  | {
      kind: "RESOLVED";
      latitude: number;
      longitude: number;
      precision: Extract<AddressPrecision, "ADDRESS" | "STREET">;
      /**
       * The root delivery the point was copied from (reusablePoint); absent
       * for the provider's own answer, a point of the delivery's own.
       */
      copiedFrom?: string | null;
    }
  | {
      kind: "COARSE";
      precision: Extract<AddressPrecision, "NEIGHBORHOOD" | "CITY">;
      /** A verdict taken from the door (reusableVerdict): its own date. */
      decidedAt?: Date;
    }
  | {
      kind: "NOT_FOUND";
      /** A verdict taken from the door (reusableVerdict): its own date. */
      decidedAt?: Date;
    }
  | { kind: "FAILED" };

/**
 * What the provider last said about a door it could not place (plano-escala
 * F2-33): nothing at all, or a district or a city only, and when it said
 * so — the date the window counts from, which a copy keeps.
 */
type ReusedVerdict =
  | { kind: "NOT_FOUND"; decidedAt: Date }
  | {
      kind: "COARSE";
      precision: Extract<AddressPrecision, "NEIGHBORHOOD" | "CITY">;
      decidedAt: Date;
    };

/**
 * The unfinished route a delivery is an open stop of, for telling the
 * screens that its point arrived. The company comes from the route row.
 */
interface OpenStopRoute {
  deliveryId: string;
  routeId: string;
  businessId: string;
  routeStatus: RouteStatus;
  /** The driver's user, when the route is theirs (RELEASED, IN_PROGRESS). */
  driverUserId: string | null;
}

interface IDeliveryGeocodingRepository {
  /** Up to `limit` claimable deliveries, newest first, stamped `now`. */
  claim(limit: number, now: Date): Promise<GeocodingClaim[]>;

  /**
   * The same claim, over the deliveries that are an open stop of an
   * unfinished route only: what a driver will visit, and a route page
   * shows. The job asks it first, so a routed address never waits behind
   * a newer spreadsheet.
   */
  claimOpenStops(limit: number, now: Date): Promise<GeocodingClaim[]>;

  /**
   * The same claim, over these deliveries of this company only: what a
   * create, an address edit or a routing asks right after its commit.
   */
  claimByIds(
    ids: readonly string[],
    businessId: string,
    limit: number,
    now: Date,
  ): Promise<GeocodingClaim[]>;

  /**
   * The point another delivery of the claim's company already has at the
   * claim's address (address-key.ts), as the columns to settle it with
   * (address-point-reuse.ts: a pin first, then the newest); null when none
   * qualifies. Never another company's, never the claim's own row.
   */
  reusablePoint(
    claim: GeocodingClaim,
    now: Date,
  ): Promise<ReusedAddressPoint | null>;

  /**
   * The newest verdict without a point (NOT_FOUND or COARSE) the provider
   * gave since `since` about another delivery of the claim's company at
   * the claim's door, with its date; null when none. Never another
   * company's, never a delivery that has a point by now (a pin since is
   * the point reuse's), never a failure.
   */
  reusableVerdict(
    claim: GeocodingClaim,
    since: Date,
  ): Promise<ReusedVerdict | null>;

  /**
   * Writes the outcome when the claim still holds and the delivery still
   * has no point (a dispatcher's pin wins, always) — and, for a copied
   * point, while its root still holds it (lenderHolds). True when written.
   */
  settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean>;

  /**
   * Gives a claim back unasked — the provider refused or limited the run,
   * or the budget ran out — as it was before it: attempts and
   * geocode_attempted_at restored, so the next run takes it at once. A
   * no-op when the claim no longer holds (an address edit cleared it).
   */
  release(claim: GeocodingClaim): Promise<boolean>;

  /** The unfinished routes holding these deliveries as open stops. */
  openStopRoutes(deliveryIds: readonly string[]): Promise<OpenStopRoute[]>;
}

/**
 * A copied verdict keeps the date of the answer it copies in a column of
 * its own, which the window reads before the claim's instant: a delivery
 * that copies a copy never stretches the window, and the door is asked
 * again once the provider's own answer is older than it. It went in
 * geocode_attempted_at until the review of F2-33, which the API documents
 * as the last attempt: a delivery created today read a last attempt weeks
 * before it existed. Every other outcome writes NULL, so the column says
 * only what it says.
 */
function verdictAtOf(settlement: GeocodingSettlement): Date | null {
  return (settlement.kind === "NOT_FOUND" || settlement.kind === "COARSE") &&
    settlement.decidedAt
    ? settlement.decidedAt
    : null;
}

/**
 * The date a verdict without a point stands on: the copied answer's for a
 * copy, the claim's instant for the delivery's own answer (and for every
 * row the previous image wrote, which copies none).
 */
const VERDICT_DATE = Prisma.sql`COALESCE("geocode_verdict_at", "geocode_attempted_at")`;

/** A row of the door as the verdict it is; null for anything else. */
function verdictOf(
  row:
    | {
        geocode_status: string | null;
        geo_precision: string | null;
        decidedAt: Date | null;
      }
    | undefined,
): ReusedVerdict | null {
  if (!row?.decidedAt) return null;

  const decidedAt = new Date(row.decidedAt);

  if (row.geocode_status === "NOT_FOUND")
    return { kind: "NOT_FOUND", decidedAt };

  if (
    row.geocode_status === "COARSE" &&
    (row.geo_precision === "NEIGHBORHOOD" || row.geo_precision === "CITY")
  ) {
    return { kind: "COARSE", precision: row.geo_precision, decidedAt };
  }

  return null;
}

/** The routes whose open stops the screens draw: not finished yet. */
const UNFINISHED_ROUTE_STATUSES: RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
];

class DeliveryGeocodingRepository implements IDeliveryGeocodingRepository {
  constructor(private readonly prisma = database) {}

  async claim(limit: number, now: Date): Promise<GeocodingClaim[]> {
    return this.claimWhere(Prisma.empty, limit, now);
  }

  async claimOpenStops(limit: number, now: Date): Promise<GeocodingClaim[]> {
    if (limit <= 0) return [];

    // A probe per candidate, newest first, of route_stop_active_delivery_idx
    // (its predicate spelled out: one open stop per delivery) and of the
    // route's primary key. The candidates are the claim's own, over its
    // partial index; the run asks only while the day's budget lasts.
    return this.claimWhere(
      Prisma.sql`AND EXISTS (
          SELECT 1
          FROM "route_stop" AS s
          JOIN "route" AS r ON r."id" = s."routeId"
          WHERE s."deliveryId" = "delivery"."id"
            AND s."status" IN ('PENDING', 'ARRIVED')
            AND r."status" IN ('PLANNED', 'RELEASED', 'IN_PROGRESS')
        )`,
      limit,
      now,
    );
  }

  async claimByIds(
    ids: readonly string[],
    businessId: string,
    limit: number,
    now: Date,
  ): Promise<GeocodingClaim[]> {
    if (ids.length === 0 || limit <= 0) return [];

    // The company as well as the ids: a caller's list never reaches another
    // tenant's row, whatever it carries.
    return this.claimWhere(
      Prisma.sql`AND "id" = ANY(${[...ids]}::text[])
        AND "businessId" = ${businessId}`,
      limit,
      now,
    );
  }

  /**
   * The claim, with an optional extra filter. The status literals and the
   * geocode_status literal are spelled out so the planner can prove
   * delivery_geocode_pending_idx in a generic plan; the attempts and the
   * back-off are filters over it. RETURNING keeps no order, so the claimed
   * rows are sorted again outside.
   */
  private async claimWhere(
    scope: Prisma.Sql,
    limit: number,
    now: Date,
  ): Promise<GeocodingClaim[]> {
    return this.prisma.$queryRaw<GeocodingClaim[]>`
      WITH picked AS (
        SELECT "id", "geocode_attempted_at" AS "previousAttemptedAt"
        FROM "delivery"
        WHERE "latitude" IS NULL
          AND "geo_source" IS NULL
          AND ("geocode_status" IS NULL OR "geocode_status" = 'FAILED')
          AND "status" IN ('PENDING', 'IN_TRANSIT')
          AND "geocode_attempts" < ${GEOCODING_MAX_ATTEMPTS}
          AND (
            "geocode_attempted_at" IS NULL
            OR "geocode_attempted_at" <
              ${now}::timestamp - make_interval(mins => LEAST(
                ${GEOCODING_BACKOFF_MINUTES}::int
                  * power(2, GREATEST("geocode_attempts" - 1, 0))::int,
                ${GEOCODING_BACKOFF_CAP_MINUTES}::int
              ))
          )
          ${scope}
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE "delivery" AS d
        SET "geocode_attempted_at" = ${now},
            "geocode_attempts" = d."geocode_attempts" + 1
        FROM picked
        WHERE d."id" = picked."id"
        RETURNING d."id", d."businessId", d."street", d."address_number",
          d."neighborhood", d."city", d."uf", d."cep", d."created_at",
          d."geocode_attempted_at" AS "claimedAt",
          d."geocode_attempts" AS "attempts",
          picked."previousAttemptedAt"
      )
      SELECT "id", "businessId", "street", "address_number", "neighborhood",
        "city", "uf", "cep", "claimedAt", "attempts", "previousAttemptedAt"
      FROM claimed
      ORDER BY "created_at" DESC, "id" DESC
    `;
  }

  async reusablePoint(
    claim: GeocodingClaim,
    now: Date,
  ): Promise<ReusedAddressPoint | null> {
    const key = deliveryAddressKey(claim);

    if (!key) return null;

    // The newest of each source at this door; the rule decides between
    // the two, as the twin decides over every row.
    const candidates = await readDoorCandidates(this.prisma, {
      businessId: claim.businessId,
      addressKey: key,
      exceptId: claim.id,
    });

    return pickReusablePoint(candidates, now, claim.id);
  }

  async reusableVerdict(
    claim: GeocodingClaim,
    since: Date,
  ): Promise<ReusedVerdict | null> {
    const key = deliveryAddressKey(claim);

    if (!key) return null;

    // delivery_address_key_idx down to the door's rows without a source
    // (geo_source IS NULL is an index condition, the key's equality proves
    // the predicate): the not-located ones, a handful even at a busy door,
    // dated and ordered by the answer each one stands on.
    const [row] = await this.prisma.$queryRaw<
      Array<{
        geocode_status: "NOT_FOUND" | "COARSE";
        geo_precision: string | null;
        decidedAt: Date;
      }>
    >`
      SELECT "geocode_status", "geo_precision",
        ${VERDICT_DATE} AS "decidedAt"
      FROM "delivery"
      WHERE "businessId" = ${claim.businessId}
        AND "address_key" = ${key}
        AND "geo_source" IS NULL
        AND "latitude" IS NULL
        AND "id" <> ${claim.id}
        AND "geocode_status" IN ('NOT_FOUND', 'COARSE')
        AND ${VERDICT_DATE} >= ${since}
      ORDER BY ${VERDICT_DATE} DESC, "id" DESC
      LIMIT 1
    `;

    return verdictOf(row);
  }

  async settle(
    claim: GeocodingClaim,
    settlement: GeocodingSettlement,
    now: Date,
  ): Promise<boolean> {
    // The link to a copied point's root goes with every outcome: the
    // provider's answer is the delivery's own (null), and a link an older
    // image left on a row without a point goes with it.
    const copiedFrom =
      settlement.kind === "RESOLVED" ? (settlement.copiedFrom ?? null) : null;
    const verdictAt = verdictAtOf(settlement);
    const set = (() => {
      switch (settlement.kind) {
        case "RESOLVED":
          return Prisma.sql`
            "latitude" = ${settlement.latitude},
            "longitude" = ${settlement.longitude},
            "geo_source" = 'GEOCODER',
            "geo_updated_at" = ${now},
            "geo_precision" = ${settlement.precision}::"DeliveryGeoPrecision",
            "geocode_status" = 'RESOLVED',
            "geo_copied_from" = ${copiedFrom},
            "geocode_verdict_at" = NULL`;
        case "COARSE":
          return Prisma.sql`
            "geo_precision" = ${settlement.precision}::"DeliveryGeoPrecision",
            "geocode_status" = 'COARSE',
            "geo_copied_from" = NULL,
            "geocode_verdict_at" = ${verdictAt}`;
        case "NOT_FOUND":
          return Prisma.sql`"geocode_status" = 'NOT_FOUND',
            "geo_copied_from" = NULL,
            "geocode_verdict_at" = ${verdictAt}`;
        case "FAILED":
          return Prisma.sql`"geocode_status" = 'FAILED',
            "geo_copied_from" = NULL,
            "geocode_verdict_at" = NULL`;
      }
    })();
    // A copy is written only while its root still holds the point, the
    // root locked FOR SHARE by the same statement (lenderHolds).
    const guard =
      settlement.kind === "RESOLVED" && copiedFrom
        ? lenderHolds(claim.businessId, {
            latitude: settlement.latitude,
            longitude: settlement.longitude,
            geo_source: "GEOCODER",
            geo_precision: settlement.precision,
            geocode_status: "RESOLVED",
            geo_updated_at: now,
            geo_copied_from: copiedFrom,
          })
        : Prisma.sql`TRUE`;

    // Not a business edit: updated_at stays, so nothing that watches it
    // (the public API's updated_since) sees a change the customer did not
    // make.
    const written = await this.prisma.$executeRaw`
      UPDATE "delivery" SET ${set}
      WHERE "id" = ${claim.id}
        AND "geocode_attempted_at" = ${claim.claimedAt}
        AND "latitude" IS NULL
        AND "geo_source" IS NULL
        AND ${guard}
    `;

    return written === 1;
  }

  async release(claim: GeocodingClaim): Promise<boolean> {
    // The status stays: a delivery that had failed before is still FAILED,
    // with the attempts it really made. updated_at stays, as in the settle.
    const written = await this.prisma.$executeRaw`
      UPDATE "delivery"
      SET "geocode_attempted_at" = ${claim.previousAttemptedAt},
          "geocode_attempts" = GREATEST("geocode_attempts" - 1, 0)
      WHERE "id" = ${claim.id}
        AND "geocode_attempted_at" = ${claim.claimedAt}
    `;

    return written === 1;
  }

  async openStopRoutes(
    deliveryIds: readonly string[],
  ): Promise<OpenStopRoute[]> {
    if (deliveryIds.length === 0) return [];

    // Bounded by one run's settles (at most a batch) over the stop's
    // deliveryId index.
    const stops = await this.prisma.routeStop.findMany({
      where: {
        deliveryId: { in: [...deliveryIds] },
        status: { in: OPEN_STOP_STATUSES },
        route: { status: { in: UNFINISHED_ROUTE_STATUSES } },
      },
      select: {
        deliveryId: true,
        route: {
          select: { id: true, businessId: true, status: true, driverId: true },
        },
      },
    });

    // The driver's user only for a route that is theirs already — asked per
    // stop below too: one driver can hold a released route and a planned one.
    const theirs = (status: string) =>
      status === "RELEASED" || status === "IN_PROGRESS";

    const driverIds = [
      ...new Set(
        stops
          .filter((stop) => theirs(stop.route.status))
          .map((stop) => stop.route.driverId),
      ),
    ];

    const users =
      driverIds.length > 0
        ? await this.prisma.user.findMany({
            where: { driverId: { in: driverIds } },
            select: { id: true, driverId: true },
          })
        : [];

    const userOf = new Map<string, string>();

    for (const user of users) {
      if (user.driverId && !userOf.has(user.driverId)) {
        userOf.set(user.driverId, user.id);
      }
    }

    return stops.map((stop) => ({
      deliveryId: stop.deliveryId,
      routeId: stop.route.id,
      businessId: stop.route.businessId,
      routeStatus: stop.route.status as RouteStatus,
      driverUserId: theirs(stop.route.status)
        ? (userOf.get(stop.route.driverId) ?? null)
        : null,
    }));
  }
}

export {
  DeliveryGeocodingRepository,
  GEOCODING_BACKOFF_CAP_MINUTES,
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_MAX_ATTEMPTS,
  UNFINISHED_ROUTE_STATUSES,
  geocodingBackoffMinutes,
  verdictOf,
};
export type {
  GeocodingClaim,
  GeocodingSettlement,
  IDeliveryGeocodingRepository,
  OpenStopRoute,
  ReusedVerdict,
};
