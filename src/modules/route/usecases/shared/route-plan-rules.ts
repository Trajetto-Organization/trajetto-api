import { AppError } from "@/shared/errors/AppError";

import {
  RoutePlanStaleError,
  RouteStopsLimitError,
} from "../errors/route-errors";

/**
 * The most open stops one route holds (decision 14.7, D11). Equal to the
 * reorder's own ceiling: a route that could be built bigger than it can be
 * reordered was a route nobody could fix.
 */
const ROUTE_MAX_STOPS = 200;

/** The add/move batch ceiling, per request. */
const ROUTE_STOPS_BATCH_MAX = 100;

/**
 * Delivery events that describe the PLAN, not the operation: a stop added to
 * or taken off a route that has not left. The tower feed reads what happened
 * on the street and skips these.
 */
const PLANNING_EVENT_TYPES = ["ROUTE_ADDED", "ROUTE_REMOVED"] as const;

/**
 * Whether plan changes write those two types on the delivery's trail.
 *
 * Off until every reader knows them: the delivery timeline builder, its
 * documented enum, the web timeline's KIND_META (which dereferences the kind
 * and crashed the delivery dialog on an unknown one) and the public events
 * feed. Those live outside the route module; flip this together with them.
 *
 * API readers are ready: the timeline builder titles both kinds, the
 * documented enums carry them and the public feed leaves them out. Still
 * waiting: the web timeline's KIND_META (and its fallback for an unknown
 * kind). When flipping, add both kinds to DOCUMENTED_TIMELINE_KINDS in
 * tests/E2E/route-assignment-unit-http.test.ts.
 */
const PLANNING_TIMELINE_EVENTS_ENABLED = false;

/**
 * The version check every plan write makes under the route lock. Absent
 * `expected` keeps the old contract (last writer wins) for clients that do
 * not send it yet.
 */
function assertPlanVersion(
  current: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== current) {
    throw new RoutePlanStaleError(current);
  }
}

/** The 409s and 400s the plan writes share, as HTTP answers. */
function planWriteFailure(error: unknown): AppError | null {
  if (error instanceof RoutePlanStaleError) {
    return new AppError(error.message, 409, "ROUTE_PLAN_STALE");
  }

  if (error instanceof RouteStopsLimitError) {
    return new AppError(error.message, 400, "ROUTE_STOPS_LIMIT");
  }

  return null;
}

/**
 * "Já está na Rota 12": the 409 names where each delivery is, so the
 * dispatcher can drop it from the selection or go move it (§4.3).
 */
function alreadyOnRouteMessage(
  elsewhere: Array<{ deliveryId: string; routeCode: number }>,
  labelOf: (deliveryId: string) => string,
): string {
  const byRoute = new Map<number, string[]>();

  for (const entry of elsewhere) {
    byRoute.set(entry.routeCode, [
      ...(byRoute.get(entry.routeCode) ?? []),
      labelOf(entry.deliveryId),
    ]);
  }

  const parts = [...byRoute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([code, labels]) => `${labels.join(", ")} (Rota ${code})`);

  return elsewhere.length === 1
    ? `A entrega ${parts[0]} já está em outra rota. Atualize a lista e tente novamente.`
    : `Estas entregas já estão em outra rota: ${parts.join("; ")}. Atualize a lista e tente novamente.`;
}

export {
  PLANNING_EVENT_TYPES,
  PLANNING_TIMELINE_EVENTS_ENABLED,
  ROUTE_MAX_STOPS,
  ROUTE_STOPS_BATCH_MAX,
  alreadyOnRouteMessage,
  assertPlanVersion,
  planWriteFailure,
};
