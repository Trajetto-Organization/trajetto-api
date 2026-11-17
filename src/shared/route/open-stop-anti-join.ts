import type { Prisma } from "@prisma/client";

import type { RouteStatus, RouteStopStatus } from "./route-rules";

/**
 * The route statuses that can still hold an open stop: the route has not
 * ended. Ending a route (completed, closed with pending stops or cancelled)
 * cancels its open stops in the same transaction (route-repository's
 * mirrorOntoDeliveries), so an open stop on any other route status does not
 * exist — tests/E2E/route-lifecycle.test.ts guards that invariant.
 */
const OPEN_ROUTE_STATUSES: RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
];

/** Same list as OPEN_STOP_STATUSES, spelled here so the filter reads whole. */
const HELD_STOP_STATUSES: RouteStopStatus[] = ["PENDING", "ARRIVED"];

/**
 * "Not on an open stop", inside one company (plan F2-21).
 *
 * Prisma 7 sends `stops: { none: … }` as a NOT EXISTS correlated on the
 * delivery's id (Prisma 6 sent an uncorrelated NOT IN). Over a page's worth
 * of deliveries the planner runs it as a hash anti-join, building the hash
 * from every row the subquery returns before the correlation. With only the
 * stop's status in it, that was every open stop of the platform — a few
 * hundred today, ~150,000 at the scale plan's target, read on every query
 * of the route builder's picker (tests/E2E/query-plans-scale.test.ts).
 *
 * The tenant's open routes bound it. route_stop has no businessId of its
 * own, so the company comes through the route, and the route's status keeps
 * the walk on route (businessId, status, scheduled_date) to the routes that
 * have not ended — not to every route the company ever ran — and from there
 * to route_stop (routeId, status). The result is the same set the old filter
 * matched: an open stop only exists on an open route of the delivery's own
 * company (a stop is only ever added to a route of the delivery's company).
 *
 * The in-memory twins keep the stop-status test alone: under that
 * invariant it answers the same.
 */
function notOnAnOpenStop(businessId: string): Prisma.DeliveryWhereInput {
  return {
    stops: {
      none: {
        status: { in: HELD_STOP_STATUSES },
        route: { businessId, status: { in: OPEN_ROUTE_STATUSES } },
      },
    },
  };
}

export { OPEN_ROUTE_STATUSES, notOnAnOpenStop };
