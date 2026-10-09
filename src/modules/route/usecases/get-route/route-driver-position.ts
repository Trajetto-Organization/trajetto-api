import { isPositionFresh } from "@/shared/route/driver-position-rules";

import type { StoredPosition } from "../../repositories/IDriver-position-repository";
import type { RouteStatus } from "@/shared/route/route-rules";

interface RouteDriverPosition {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  recordedAt: string;

  /** Within POSITION_FRESH_MS (10 min), the tower's own rule. */
  fresh: boolean;
}

/**
 * The driver's dot on THIS route's map, or null (decision 14.7, §4.2).
 *
 * Only for a route the driver holds now (RELEASED or IN_PROGRESS), and only a
 * point that belongs to it: recorded on this route, or — for a route already
 * out — the driver's latest point whatever it was tagged with, because the
 * app tags points with the route it was running when they were taken. Never
 * the dot of another route the same driver is on: a planner looking at
 * tomorrow's route must not see today's truck on its map.
 */
function routeDriverPosition(
  route: { id: string; status: RouteStatus },
  last: StoredPosition | null,
  now: Date = new Date(),
): RouteDriverPosition | null {
  if (!last) return null;

  if (route.status !== "RELEASED" && route.status !== "IN_PROGRESS") {
    return null;
  }

  const ownPoint = last.routeId === route.id;

  if (!ownPoint && !(route.status === "IN_PROGRESS" && last.routeId === null)) {
    return null;
  }

  return {
    latitude: last.latitude,
    longitude: last.longitude,
    speed: last.speed,
    heading: last.heading,
    recordedAt: last.recorded_at.toISOString(),
    fresh: isPositionFresh(last.recorded_at, now),
  };
}

export { routeDriverPosition };
export type { RouteDriverPosition };
