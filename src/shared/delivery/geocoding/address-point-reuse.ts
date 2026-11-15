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
 *
 * The copy keeps where it came from (pre-push review of the batch of
 * 14/11/2026): geo_copied_from names the ROOT of the point — the candidate
 * itself, or, when the candidate is a copy, the root it came from, never
 * a chain — so a pin that corrects or clears the root reaches the copies
 * it handed out (address-point-propagation.ts, followSource).
 */
type ReusablePrecision = "ADDRESS" | "STREET";

/** A delivery's point as stored, a candidate to be taken. */
interface PointCandidate {
  latitude: number | null;
  longitude: number | null;
  geo_source: "MANUAL" | "GEOCODER" | null;
  geo_precision: string | null;
  geo_updated_at: Date | null;
  /**
   * The delivery the point is lent as (lendingRoot): the candidate's own
   * id, or the root its copy came from.
   */
  root: string;
}

/** The columns a delivery takes the point with. */
interface ReusedAddressPoint {
  latitude: number;
  longitude: number;
  geo_source: "GEOCODER";
  geo_precision: ReusablePrecision;
  geocode_status: "RESOLVED";
  geo_updated_at: Date;
  /**
   * The root delivery the point came from. Null only when that root is
   * the borrower itself: an address edited back to a door whose point it
   * had lent — it takes its own point back, as its own.
   */
  geo_copied_from: string | null;
}

/** A delivery row as a twin holds it, for lendingRoot. */
interface LenderRow {
  id?: string | null;
  businessId: string;
  address_key?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: string | null;
  geo_copied_from?: string | null;
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

/**
 * The root a delivery lends its point as, or null when it may no longer
 * lend it (the twins' copy of readDoorCandidates' join). A pin, a point
 * given at the create and a geocoder's own answer are their own root. A
 * copy is lent as its root while that root, still at the copy's door,
 * holds the same point. Once the root dropped it there — a pin cleared it
 * or moved it — the copy lends nothing: the closed copies the follow-up
 * leaves as they were would otherwise hand the very point a person just
 * took away to the next delivery at the door. A root gone (an import
 * undone) or moved to another address no longer speaks for this door, and
 * the copy lends as its own root.
 */
function lendingRoot<Row extends LenderRow>(
  row: Row,
  rowById: (id: string) => Row | undefined,
): string | null {
  const own = row.id ?? null;

  if (row.geo_source !== "GEOCODER" || !row.geo_copied_from) return own;

  const root = rowById(row.geo_copied_from);

  if (
    !root ||
    root.businessId !== row.businessId ||
    (root.address_key ?? null) !== (row.address_key ?? null)
  ) {
    return own;
  }

  return root.latitude === row.latitude && root.longitude === row.longitude
    ? (root.id ?? null)
    : null;
}

/**
 * The point to copy, as the columns to write; null when none qualifies.
 * `borrowerId`: the delivery taking it, when it already exists (an address
 * edit), so it never records itself as its own source.
 */
function pickReusablePoint(
  candidates: ReadonlyArray<PointCandidate>,
  now: Date,
  borrowerId: string | null = null,
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
    geo_copied_from: best.root === borrowerId ? null : best.root,
  };
}

export { REUSABLE_PRECISIONS, isReusablePoint, lendingRoot, pickReusablePoint };
export type {
  LenderRow,
  PointCandidate,
  ReusablePrecision,
  ReusedAddressPoint,
};
