/**
 * The geofence rule of an action at the customer's address (plan of
 * 02/11/2026, item E2; decisions D12-D14 and the owner's calls of
 * 03/11/2026). Pure on purpose: the driver's app runs a copy of it at the tap
 * (E3, to warn or block offline too) and the server runs this one (E4, to
 * record the distance and refuse only what the app should have stopped), and
 * both run tests/unitaires/delivery/fixtures/geofence-verdict-cases.json.
 * Change it only together with the app's copy and that file.
 *
 * Two questions, kept apart:
 *
 * - geofenceVerdict: where was the phone? INSIDE, OUTSIDE or NOT_EVALUATED.
 *   It never answers OUTSIDE on weak evidence: no address point, an address
 *   the geocoder only placed in a neighbourhood or a city, no position, no
 *   accuracy (every build before this one), accuracy worse than the radius,
 *   or a fix older than two minutes are all NOT_EVALUATED. And the fix gets
 *   the benefit of its own error: it is OUTSIDE only when even its nearest
 *   possible spot (distance minus accuracy) is past the radius.
 * - geofenceDecision: what to do about it. Only OUTSIDE ever matters. ALERT
 *   asks the driver to confirm and flags the record; BLOCK refuses an
 *   arrival or a proof made outside, but never an occurrence (a refusal at
 *   the door — "cliente ausente" — happens wherever the driver is), and never
 *   a submission the app queued offline: the server only flags those, since
 *   refusing it would turn a record of the street into a permanent failure
 *   on the driver's phone.
 */

type GeofenceMode = "DISABLED" | "ALERT" | "BLOCK";

type GeofenceOutcome = "INSIDE" | "OUTSIDE" | "NOT_EVALUATED";

/** The actions at the customer's address the geofence covers (decision D13). */
type GeofenceAction = "ARRIVAL" | "PROOF" | "OCCURRENCE";

/**
 * How precisely the address point is known. A point the dispatcher pinned
 * (MANUAL) has no level: null, read as exact. The geocoder's own levels
 * (item E1): ADDRESS (the house number), STREET, NEIGHBORHOOD, CITY — the
 * last two are not a customer's door and are never evaluated.
 */
type AddressPrecision = "ADDRESS" | "STREET" | "NEIGHBORHOOD" | "CITY";

/** Why a verdict is NOT_EVALUATED; null when it was evaluated. */
type GeofenceSkipReason =
  | "DISABLED"
  | "NO_ADDRESS_POINT"
  | "COARSE_ADDRESS"
  | "NO_POSITION"
  | "NO_ACCURACY"
  | "POOR_ACCURACY"
  | "STALE_POSITION";

interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface GeofenceVerdictInput {
  mode: GeofenceMode;
  /** The company's radius, in metres (50 to 5,000). */
  radius_m: number;
  /** Where the phone was at the tap; null when it sent none. */
  position: GeoPoint | null;
  /** The fix's accuracy, in metres, as the phone reported it. */
  accuracy_m: number | null;
  /**
   * How old the fix was at the tap, in milliseconds; null when unknown (the
   * server without the stamp), which does not count as stale.
   */
  position_age_ms: number | null;
  /** The delivery's address point; null when it has none. */
  address: GeoPoint | null;
  address_precision: AddressPrecision | null;
}

interface GeofenceVerdict {
  outcome: GeofenceOutcome;
  /**
   * Metres from the phone to the address point, rounded to 0.1 m. Null when
   * either point is missing or the address is coarse (a distance to a city's
   * centre is no distance to the customer).
   */
  distance_m: number | null;
  reason: GeofenceSkipReason | null;
}

interface GeofenceDecisionInput {
  mode: GeofenceMode;
  outcome: GeofenceOutcome;
  action: GeofenceAction;
  /**
   * Whether the action is happening now: always true on the phone at the
   * tap; on the server, tapped at most GEOFENCE_RECENT_SUBMISSION_MS before
   * it arrived (isRecentSubmission).
   */
  recent: boolean;
}

/** ALLOW: go ahead. CONFIRM: go ahead, flagged (the app asks first). REFUSE: stop. */
type GeofenceDecision = "ALLOW" | "CONFIRM" | "REFUSE";

/** A fix older than this at the tap is not the driver's position then. */
const GEOFENCE_MAX_POSITION_AGE_MS = 2 * 60 * 1000;

/**
 * A submission tapped longer ago than this came from the app's offline
 * queue: the server flags it and never refuses it (decision D14).
 */
const GEOFENCE_RECENT_SUBMISSION_MS = 2 * 60 * 1000;

/** The Earth's mean radius, the same as shared/utils/geolocation.ts. */
const EARTH_RADIUS_M = 6371e3;

const COARSE_PRECISIONS: ReadonlySet<AddressPrecision> = new Set([
  "NEIGHBORHOOD",
  "CITY",
]);

/** Inside the globe and not the (0, 0) of a missing fix. */
function isUsablePoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    !(point.latitude === 0 && point.longitude === 0)
  );
}

/** Haversine distance in metres, rounded to 0.1 m (the same in both copies). */
function distanceMetres(from: GeoPoint, to: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);

  const metres =
    EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(metres * 10) / 10;
}

function geofenceVerdict(input: GeofenceVerdictInput): GeofenceVerdict {
  const coarse =
    input.address_precision !== null &&
    COARSE_PRECISIONS.has(input.address_precision);

  const distance =
    isUsablePoint(input.position) && isUsablePoint(input.address) && !coarse
      ? distanceMetres(input.position, input.address)
      : null;

  const skip = (reason: GeofenceSkipReason): GeofenceVerdict => ({
    outcome: "NOT_EVALUATED",
    distance_m: distance,
    reason,
  });

  if (input.mode === "DISABLED") return skip("DISABLED");
  if (!isUsablePoint(input.address)) return skip("NO_ADDRESS_POINT");
  if (coarse) return skip("COARSE_ADDRESS");
  if (!isUsablePoint(input.position)) return skip("NO_POSITION");

  const accuracy = input.accuracy_m;

  if (accuracy === null || !Number.isFinite(accuracy) || accuracy < 0) {
    return skip("NO_ACCURACY");
  }

  if (accuracy > input.radius_m) return skip("POOR_ACCURACY");

  if (
    input.position_age_ms !== null &&
    input.position_age_ms > GEOFENCE_MAX_POSITION_AGE_MS
  ) {
    return skip("STALE_POSITION");
  }

  // Both points are usable and not coarse here, so the distance exists.
  const metres = distance as number;

  return {
    outcome: metres - accuracy > input.radius_m ? "OUTSIDE" : "INSIDE",
    distance_m: metres,
    reason: null,
  };
}

function geofenceDecision(input: GeofenceDecisionInput): GeofenceDecision {
  if (input.outcome !== "OUTSIDE" || input.mode === "DISABLED") return "ALLOW";

  if (input.mode === "ALERT") return "CONFIRM";

  // BLOCK: an occurrence and a queued submission are flagged, never refused.
  if (input.action === "OCCURRENCE" || !input.recent) return "CONFIRM";

  return "REFUSE";
}

/**
 * Whether a submission is happening now, by the server's clock: its tap
 * (resolveOccurredAt, already corrected for the phone's clock) at most
 * GEOFENCE_RECENT_SUBMISSION_MS ago. No tap instant means it was sent at
 * the tap.
 */
function isRecentSubmission(
  occurredAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!occurredAt) return true;

  return now.getTime() - occurredAt.getTime() <= GEOFENCE_RECENT_SUBMISSION_MS;
}

export {
  GEOFENCE_MAX_POSITION_AGE_MS,
  GEOFENCE_RECENT_SUBMISSION_MS,
  geofenceDecision,
  geofenceVerdict,
  isRecentSubmission,
};
export type {
  AddressPrecision,
  GeoPoint,
  GeofenceAction,
  GeofenceDecision,
  GeofenceDecisionInput,
  GeofenceMode,
  GeofenceOutcome,
  GeofenceSkipReason,
  GeofenceVerdict,
  GeofenceVerdictInput,
};
