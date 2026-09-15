/**
 * What counts as a usable position, and how many of them a screen gets.
 *
 * Pure, because every one of these is a judgement somebody will want to argue
 * with later and none of them needs a database to decide.
 */
interface RawPing {
  latitude: number;
  longitude: number;

  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;

  battery?: number | null;

  recorded_at: string | Date;
}

interface AcceptedPing {
  latitude: number;
  longitude: number;

  accuracy: number | null;
  speed: number | null;
  heading: number | null;

  battery: number | null;

  recorded_at: Date;
}

/**
 * The most a single flush may carry.
 *
 * A phone that spent three hours in a dead zone comes back with hundreds of
 * points, and refusing them would lose the trail for exactly the stretch
 * somebody will ask about. Five hundred at one ping every fifteen seconds is
 * just over two hours — generous, and still a bounded insert.
 */
const MAX_PINGS_PER_BATCH = 500;

/**
 * Worse than this and the point is thrown away.
 *
 * Two hundred metres puts a truck on the wrong block, which on a map is not a
 * slightly wrong answer — it is a confident wrong answer, and somebody will
 * call a driver about it. A phone indoors reports this routinely.
 */
const MAX_ACCURACY_METRES = 200;

/**
 * How far into the future a device's clock may be and still be believed.
 *
 * Phone clocks drift and some are simply set wrong. A few minutes is drift; an
 * hour ahead is a device whose points would sit at the front of every query
 * until real time caught up with them.
 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * How far back a ping may reach.
 *
 * Matches the partition retention: a point older than the oldest partition has
 * nowhere to be written, and the insert would be REFUSED rather than ignored —
 * taking the rest of the batch with it.
 */
const MAX_AGE_DAYS = 89;

/** Latitude and longitude that are actually on Earth, and not (0, 0). */
function hasRealCoordinates(ping: RawPing): boolean {
  const { latitude, longitude } = ping;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;

  // Null Island. A device with no fix reports it, and a dot in the Gulf of
  // Guinea is worse than no dot: it redraws the whole map to fit.
  return !(latitude === 0 && longitude === 0);
}

/**
 * Turns what a phone sent into what may be stored, dropping what cannot.
 *
 * Silently, and on purpose: the app is offline-first and resends, so a refusal
 * would have it retry the same bad point forever. What it sent is best effort;
 * what we keep is what a map can honestly draw.
 */
function acceptPings(
  pings: RawPing[],
  options: { now?: Date } = {},
): { accepted: AcceptedPing[]; rejected: number } {
  const now = options.now ?? new Date();

  const notAfter = now.getTime() + FUTURE_TOLERANCE_MS;
  const notBefore = now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const accepted: AcceptedPing[] = [];

  let rejected = 0;

  for (const ping of pings.slice(0, MAX_PINGS_PER_BATCH)) {
    if (!hasRealCoordinates(ping)) {
      rejected += 1;
      continue;
    }

    const recordedAt = new Date(ping.recorded_at);

    if (Number.isNaN(recordedAt.getTime())) {
      rejected += 1;
      continue;
    }

    if (recordedAt.getTime() > notAfter || recordedAt.getTime() < notBefore) {
      rejected += 1;
      continue;
    }

    const accuracy =
      typeof ping.accuracy === "number" && Number.isFinite(ping.accuracy)
        ? ping.accuracy
        : null;

    if (accuracy !== null && accuracy > MAX_ACCURACY_METRES) {
      rejected += 1;
      continue;
    }

    accepted.push({
      latitude: ping.latitude,
      longitude: ping.longitude,

      accuracy,

      speed:
        typeof ping.speed === "number" && Number.isFinite(ping.speed)
          ? ping.speed
          : null,

      heading:
        typeof ping.heading === "number" && Number.isFinite(ping.heading)
          ? ping.heading
          : null,

      battery:
        typeof ping.battery === "number" && Number.isFinite(ping.battery)
          ? Math.max(0, Math.min(100, Math.round(ping.battery)))
          : null,

      recorded_at: recordedAt,
    });
  }

  rejected += Math.max(0, pings.length - MAX_PINGS_PER_BATCH);

  return { accepted, rejected };
}

/**
 * Thins a trail down to what a browser can draw.
 *
 * A ten-hour day at one ping every fifteen seconds is 2.400 points for ONE
 * driver. Thirty drivers is 72.000 polyline vertices, which is a tab that
 * stops responding — and the shape of the route is identical at a tenth of
 * them.
 *
 * Evenly spaced by INDEX rather than by distance. Douglas-Peucker keeps corners
 * better, but it is a second algorithm to get wrong for a line that is
 * decoration next to the dot showing where the truck is now. The first and
 * last points are always kept: the last one is where the driver IS, and
 * dropping it to satisfy an even stride would be the one error nobody would
 * forgive.
 */
function downsample<T>(points: T[], max: number): T[] {
  if (max <= 0) return [];
  if (points.length <= max) return points;
  if (max === 1) return [points[points.length - 1]];

  const kept: T[] = [];

  // `max - 1` strides across the array, then the last point appended, so the
  // result is exactly `max` long and ends where the driver ended.
  const stride = (points.length - 1) / (max - 1);

  for (let index = 0; index < max - 1; index += 1) {
    kept.push(points[Math.round(index * stride)]);
  }

  kept.push(points[points.length - 1]);

  return kept;
}

/**
 * How long a position stays worth showing as "onde ele está".
 *
 * Past this the dot is a memory, and the map says so rather than quietly
 * showing a truck that has been parked out of signal for two hours as if it
 * had just reported.
 */
const POSITION_FRESH_MS = 10 * 60 * 1000;

function isPositionFresh(recordedAt: Date, now = new Date()): boolean {
  return now.getTime() - recordedAt.getTime() <= POSITION_FRESH_MS;
}

export {
  FUTURE_TOLERANCE_MS,
  MAX_ACCURACY_METRES,
  MAX_AGE_DAYS,
  MAX_PINGS_PER_BATCH,
  POSITION_FRESH_MS,
  acceptPings,
  downsample,
  hasRealCoordinates,
  isPositionFresh,
  type AcceptedPing,
  type RawPing,
};
