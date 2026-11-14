/**
 * Which point of another delivery of the company, at the same address
 * (address-key.ts), a delivery without one takes (owner's report of
 * 14/11/2026; decisions D-21 and D-23): the second delivery at a door the
 * company already located must not read "Sem localização", nor spend a
 * lookup of the provider's day on it.
 *
 * - A dispatcher's pin or a point given at the create (MANUAL) wins over
 *   one the geocoder found: a person looked at the map.
 * - Within one source, the most recent: a pin moved last is the right one.
 * - From the geocoder, only a point at the number or on the street
 *   (ADDRESS, STREET); a district or a city has no point to take, and a
 *   NOT_FOUND none at all.
 *
 * The copy is always written as GEOCODER, RESOLVED — the precision of its
 * origin, ADDRESS for a MANUAL one — never as MANUAL: the public API's
 * replay compares a MANUAL point with the body it was created from
 * (replay-fingerprint.ts), and an ERP resending the same order without
 * coordinates would meet a 409 IDEMPOTENCY_KEY_REUSED. The geofence of the
 * API and of the app reads GEOCODER at ADDRESS or STREET as exact
 * (geofence-rules.ts), and the web shows it as "Pelo endereço".
 */
type ReusablePrecision = "ADDRESS" | "STREET";

/** A delivery's point as stored, a candidate to be taken. */
interface PointCandidate {
  latitude: number | null;
  longitude: number | null;
  geo_source: "MANUAL" | "GEOCODER" | null;
  geo_precision: string | null;
  geo_updated_at: Date | null;
}

/** The columns a delivery takes the point with. */
interface ReusedAddressPoint {
  latitude: number;
  longitude: number;
  geo_source: "GEOCODER";
  geo_precision: ReusablePrecision;
  geocode_status: "RESOLVED";
  geo_updated_at: Date;
}

const REUSABLE_PRECISIONS: ReadonlySet<string> = new Set(["ADDRESS", "STREET"]);

/** A point another delivery may take: a whole pair, a person's or a door's. */
function isReusablePoint(candidate: PointCandidate): boolean {
  if (
    typeof candidate.latitude !== "number" ||
    typeof candidate.longitude !== "number" ||
    !Number.isFinite(candidate.latitude) ||
    !Number.isFinite(candidate.longitude)
  ) {
    return false;
  }

  return (
    candidate.geo_source === "MANUAL" ||
    (candidate.geo_source === "GEOCODER" &&
      REUSABLE_PRECISIONS.has(candidate.geo_precision ?? ""))
  );
}

/** MANUAL first, then the most recent; a point never dated comes last. */
function ranksAbove(a: PointCandidate, b: PointCandidate): boolean {
  if (a.geo_source !== b.geo_source) return a.geo_source === "MANUAL";

  return (
    (a.geo_updated_at?.getTime() ?? -1) > (b.geo_updated_at?.getTime() ?? -1)
  );
}

/** The point to copy, as the columns to write; null when none qualifies. */
function pickReusablePoint(
  candidates: ReadonlyArray<PointCandidate>,
  now: Date,
): ReusedAddressPoint | null {
  const best = candidates
    .filter(isReusablePoint)
    .reduce<PointCandidate | null>(
      (top, candidate) =>
        !top || ranksAbove(candidate, top) ? candidate : top,
      null,
    );

  if (!best) return null;

  return {
    latitude: best.latitude as number,
    longitude: best.longitude as number,
    geo_source: "GEOCODER",
    geo_precision:
      best.geo_source === "MANUAL"
        ? "ADDRESS"
        : (best.geo_precision as ReusablePrecision),
    geocode_status: "RESOLVED",
    geo_updated_at: now,
  };
}

export { REUSABLE_PRECISIONS, isReusablePoint, pickReusablePoint };
export type { PointCandidate, ReusablePrecision, ReusedAddressPoint };
