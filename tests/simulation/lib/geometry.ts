/**
 * The geometry the virtual vehicles drive on. Pure: no clock, no I/O.
 *
 * Coordinates come as [longitude, latitude] (GeoJSON, the fixture's order);
 * points handed back carry named `lat`/`lng`. Distances are great-circle
 * metres on the same mean radius the web's vehicle-motion.ts uses, so the
 * tower and the simulator agree on what "600 m away" means.
 */
type LngLat = [number, number];

interface GeoPoint {
  lat: number;
  lng: number;
}

interface Polyline {
  /** The points, consecutive duplicates removed. */
  points: LngLat[];

  /** Metres from the first point to each point (cumulative[0] === 0). */
  cumulative: number[];

  /** Total length in metres. */
  length: number;
}

interface PointOnLine extends GeoPoint {
  /** Direction of travel there, clockwise from north, in [0, 360). */
  heading: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

function normalizeAngle(degrees: number): number {
  const angle = degrees % 360;

  return angle < 0 ? angle + 360 : angle;
}

function haversineMetres(from: LngLat, to: LngLat): number {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from one point to the next, in [0, 360). */
function bearingDegrees(from: LngLat, to: LngLat): number {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLng = toRadians(lng2 - lng1);

  const y = Math.sin(dLng) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);

  return normalizeAngle(toDegrees(Math.atan2(y, x)));
}

/** The point `metres` away from `from` along `bearing` (great circle). */
function offsetPoint(from: LngLat, metres: number, bearing: number): LngLat {
  const [lng, lat] = from;
  const delta = metres / EARTH_RADIUS_M;
  const theta = toRadians(bearing);
  const phi1 = toRadians(lat);
  const lambda1 = toRadians(lng);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) +
      Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );

  return [toDegrees(lambda2), toDegrees(phi2)];
}

function buildPolyline(coords: readonly LngLat[]): Polyline {
  if (coords.length === 0)
    throw new Error("Polyline needs at least one point.");

  const points: LngLat[] = [];

  for (const point of coords) {
    const last = points[points.length - 1];

    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      points.push([point[0], point[1]]);
    }
  }

  const cumulative = [0];

  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] + haversineMetres(points[index - 1], points[index]),
    );
  }

  return { points, cumulative, length: cumulative[cumulative.length - 1] };
}

/** Index of the segment [i, i+1] holding `distance` (binary search). */
function segmentAt(line: Polyline, distance: number): number {
  let low = 0;
  let high = line.cumulative.length - 1;

  while (high - low > 1) {
    const middle = (low + high) >> 1;

    if (line.cumulative[middle] <= distance) low = middle;
    else high = middle;
  }

  return low;
}

/** Where the line is `distance` metres from its start, clamped to its ends. */
function pointAt(line: Polyline, distance: number): PointOnLine {
  const { points, cumulative } = line;

  if (points.length === 1) {
    return { lng: points[0][0], lat: points[0][1], heading: 0 };
  }

  const clamped = Math.min(Math.max(distance, 0), line.length);
  const index = Math.min(segmentAt(line, clamped), points.length - 2);

  const from = points[index];
  const to = points[index + 1];
  const span = cumulative[index + 1] - cumulative[index];
  const ratio = span > 0 ? (clamped - cumulative[index]) / span : 0;

  return {
    lng: from[0] + (to[0] - from[0]) * ratio,
    lat: from[1] + (to[1] - from[1]) * ratio,
    heading: bearingDegrees(from, to),
  };
}

/**
 * The first distance along the line, up to `until`, from which `target` is
 * at most `metres` away in a straight line: where a driver "arrives" early.
 * Walks back from `until` in 5 m steps and refines the crossing; answers 0
 * when even the start is already that close.
 */
function distanceAlongToReach(
  line: Polyline,
  target: LngLat,
  metres: number,
  until: number,
): number {
  const away = (along: number) => {
    const point = pointAt(line, along);

    return haversineMetres([point.lng, point.lat], target);
  };

  const STEP = 5;
  let near = Math.min(until, line.length);

  for (let along = near; along >= 0; along -= STEP) {
    if (away(along) >= metres) {
      // Bisect between this step (far enough) and the previous one (too near).
      let far = along;

      for (let round = 0; round < 30; round += 1) {
        const middle = (far + near) / 2;

        if (away(middle) >= metres) far = middle;
        else near = middle;
      }

      return far;
    }

    near = along;
  }

  return 0;
}

export {
  bearingDegrees,
  buildPolyline,
  distanceAlongToReach,
  haversineMetres,
  normalizeAngle,
  offsetPoint,
  pointAt,
};
export type { GeoPoint, LngLat, PointOnLine, Polyline };
