import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPolyline, pointAt, type LngLat, type Polyline } from "./geometry";

/**
 * The street geometry of the day (fixtures/delivery-day-geometry.json,
 * prebuilt from OSRM trips over OpenStreetMap data, ODbL): a depot and five
 * round trips, each stop's coordinates being its delivery's address point.
 *
 * Each route becomes ONE polyline (depot → stops → depot) and every stop a
 * distance along it, so the truck only ever moves forward: a cancelled stop
 * is driven past, an added one sits further along the same streets.
 */
interface FixtureStop {
  street: string;
  number: string;
  district: string;
  zip: string;
  lat: number;
  lng: number;
}

interface FixtureLeg {
  distance_m: number;
  duration_s: number;
  coords: LngLat[];
}

interface FixtureRoute {
  code: string;
  name: string;
  stops: FixtureStop[];
  legs: FixtureLeg[];
}

interface Fixture {
  generatedFrom: string;
  depot: FixtureStop & { name: string };
  routes: FixtureRoute[];
}

interface RoutePlan {
  code: string;
  name: string;
  line: Polyline;
  stops: FixtureStop[];

  /** Metres along `line` where each fixture stop is. */
  stopAlong: number[];

  /** Metres along `line` where each leg ends (the last one is the depot). */
  legEnd: number[];

  /** OSRM's average speed of each leg, km/h (bounded to city traffic). */
  legSpeedKmh: number[];
}

const FIXTURE_PATH = resolve(
  __dirname,
  "..",
  "fixtures",
  "delivery-day-geometry.json",
);

function loadFixture(path = FIXTURE_PATH): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function planRoute(route: FixtureRoute): RoutePlan {
  const coords: LngLat[] = [];
  const legLastIndex: number[] = [];

  for (const leg of route.legs) {
    for (const point of leg.coords) {
      const last = coords[coords.length - 1];

      if (!last || last[0] !== point[0] || last[1] !== point[1])
        coords.push(point);
    }

    legLastIndex.push(coords.length - 1);
  }

  const line = buildPolyline(coords);
  const legEnd = legLastIndex.map((index) => line.cumulative[index]);

  return {
    code: route.code,
    name: route.name,
    line,
    stops: route.stops,
    stopAlong: legEnd.slice(0, route.stops.length),
    legEnd,
    legSpeedKmh: route.legs.map((leg) =>
      Math.min(
        45,
        Math.max(18, (leg.distance_m / Math.max(leg.duration_s, 1)) * 3.6),
      ),
    ),
  };
}

/** Which leg the distance `along` falls in (for its speed). */
function legIndexAt(plan: RoutePlan, along: number): number {
  const index = plan.legEnd.findIndex((end) => along <= end + 0.001);

  return index < 0 ? plan.legEnd.length - 1 : index;
}

/** A point `ratio` of the way along the last leg (the K12 delivery). */
function pointOnReturnLeg(
  plan: RoutePlan,
  ratio: number,
): { along: number; lat: number; lng: number } {
  const start = plan.legEnd[plan.legEnd.length - 2];
  const along = start + (plan.line.length - start) * ratio;
  const point = pointAt(plan.line, along);

  return { along, lat: point.lat, lng: point.lng };
}

export { FIXTURE_PATH, legIndexAt, loadFixture, planRoute, pointOnReturnLeg };
export type { Fixture, FixtureRoute, FixtureStop, RoutePlan };
