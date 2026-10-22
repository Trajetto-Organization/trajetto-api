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
 * somebody will ask about.
 *
 * At least what the app may buffer (900), on purpose. The app sent its whole
 * buffer in one request while this was 500: past 500 points every flush was
 * refused, the batch went back, and the buffer never shrank — tracking dead on
 * that phone for good. The app now sends 200 at a time, but the builds already
 * in drivers' hands do not, and this is what lets them recover without an
 * update. Still a bounded insert: one statement, a couple of hundred KB.
 */
const MAX_PINGS_PER_BATCH = 1000;

/** The app's buffer ceiling (trajetto-mobile, position-rules MAX_BUFFERED). */
const APP_MAX_BUFFERED = 900;

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
 * Matches the partition retention. It is not a promise that a partition
 * exists: for the first weeks after the migration the oldest partition is its
 * first day, and nights the job missed leave gaps. A point with no partition
 * is dropped on its own by the repository (splitByPartition) instead of
 * failing the flush, which it used to take down whole.
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

/**
 * The newest point of a batch by DEVICE time, not by position in the body.
 *
 * A phone's outbox can resend an older batch after a newer one, and nothing
 * makes a buffer come out in order. The last element is only what the phone
 * happened to send last. On a tie the later element wins, as it always did.
 */
function latestPing<T extends { recorded_at: Date }>(pings: readonly T[]): T {
  return pings.reduce((newest, ping) =>
    ping.recorded_at.getTime() >= newest.recorded_at.getTime() ? ping : newest,
  );
}

/**
 * The route a point belongs to, by when it was RECORDED, not received.
 *
 * A phone out of signal since the morning flushes its backlog after the
 * afternoon route has started; stamped at reception, the morning's points
 * were credited to the afternoon route — its distance, its time, its trail in
 * a dispute. A point from before the running route's departure belongs to no
 * route we can name here, so it is kept in the driver's trail without one.
 *
 * A route with no departure time (never true for IN_PROGRESS, but the column
 * is nullable) claims every point, which is what reception did.
 */
function routeOfPing(
  recordedAt: Date,
  route: { id: string; started_at: Date | null } | null,
): string | null {
  if (!route) return null;

  if (route.started_at && recordedAt.getTime() < route.started_at.getTime()) {
    return null;
  }

  return route.id;
}

/** One partition of driver_position, in epoch ms: `from` inclusive, `to` exclusive. */
interface PartitionRange {
  from: number;
  to: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One edge of a bound as pg_get_expr prints it: 'timestamp', MINVALUE or MAXVALUE. */
function parseBoundEdge(edge: string): number | null {
  if (/^MINVALUE$/i.test(edge)) return -Infinity;
  if (/^MAXVALUE$/i.test(edge)) return Infinity;

  const literal = /^'(.+)'$/.exec(edge)?.[1];

  if (!literal) return null;

  // recorded_at is `timestamp without time zone` holding UTC, so a bare
  // literal is UTC. An explicit offset ("+03", "+05:30") is honoured.
  const iso = literal.replace(" ", "T");
  const withZone = /(Z|[+-]\d{2}(:?\d{2})?)$/.test(iso)
    ? iso.replace(/([+-]\d{2})$/, "$1:00")
    : `${iso}Z`;

  const time = new Date(withZone).getTime();

  return Number.isNaN(time) ? null : time;
}

/**
 * Reads `pg_get_expr(relpartbound)` for one range partition.
 *
 * "FOR VALUES FROM ('2026-09-14 00:00:00') TO ('2026-09-15 00:00:00')" is what
 * the migration and the nightly job create. DEFAULT, list partitions and
 * anything unreadable come back as null and are ignored — a point is then
 * treated as having no partition, which at worst drops a point that could have
 * been stored, never fails a flush that could have succeeded.
 */
function parsePartitionBound(bound: string): PartitionRange | null {
  const match = /FROM \((MINVALUE|'[^']+')\) TO \((MAXVALUE|'[^']+')\)/i.exec(
    bound,
  );

  if (!match) return null;

  const from = parseBoundEdge(match[1]);
  const to = parseBoundEdge(match[2]);

  return from === null || to === null ? null : { from, to };
}

/**
 * Splits a flush into the points some partition can hold and the ones none
 * can, each in its original order.
 *
 * Needed because driver_position has no DEFAULT partition on purpose (see the
 * migration): a single point outside every range fails the WHOLE insert, and
 * the phone treats that 5xx as transient and resends the same batch forever.
 */
function splitByPartition<T extends { recorded_at: Date }>(
  pings: readonly T[],
  ranges: readonly PartitionRange[],
): { writable: T[]; orphaned: T[] } {
  const writable: T[] = [];
  const orphaned: T[] = [];

  for (const ping of pings) {
    const time = ping.recorded_at.getTime();

    if (ranges.some((range) => time >= range.from && time < range.to)) {
      writable.push(ping);
    } else {
      orphaned.push(ping);
    }
  }

  return { writable, orphaned };
}

/**
 * Whether a partition for this instant may still appear.
 *
 * The nightly driver-position-partitions job creates from YESTERDAY (UTC)
 * through its lookahead on every run, and never behind that. So a point from
 * before yesterday with no partition has none for good — the migration's
 * first day, a gap left by nights the job missed — and is dropped. A point
 * from yesterday on is the job being late: the flush keeps failing and the
 * phone keeps the points until the partition exists, instead of a 200 that
 * throws away a day of every driver's trail in silence.
 */
function partitionMayStillBeCreated(
  recordedAt: Date,
  now = new Date(),
): boolean {
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  return recordedAt.getTime() >= todayUtc - DAY_MS;
}

export {
  APP_MAX_BUFFERED,
  FUTURE_TOLERANCE_MS,
  MAX_ACCURACY_METRES,
  MAX_AGE_DAYS,
  MAX_PINGS_PER_BATCH,
  POSITION_FRESH_MS,
  acceptPings,
  downsample,
  hasRealCoordinates,
  isPositionFresh,
  latestPing,
  parsePartitionBound,
  partitionMayStillBeCreated,
  routeOfPing,
  splitByPartition,
  type AcceptedPing,
  type PartitionRange,
  type RawPing,
};
