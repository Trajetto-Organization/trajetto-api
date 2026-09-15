import {
  sendRouteEventToBusiness,
  type RouteRealtimeEvent,
} from "@/websocket";

import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

/**
 * What the operation's screens are told when a stop resolves.
 *
 * Lives here rather than in each of the four delivery use cases that can
 * resolve one — arrival, proof, blocking occurrence, and the panel moving a
 * status by hand. Four copies of an event shape is four chances for the panel
 * to receive a field from three of them and not the fourth.
 *
 * Null is the ordinary answer: most deliveries in this product are not on a
 * route, and `settleStopForDelivery` says so by returning nothing. Announcing
 * that would be announcing that nothing happened.
 */
function announceStopSettled(
  businessId: string,
  settled: { stop: RouteStop; closedRoute: Route | null } | null,
): void {
  if (!settled) return;

  sendRouteEventToBusiness(businessId, {
    type: "route-stop.settled",
    routeId: settled.stop.routeId,
    stopId: settled.stop.id,
    stopStatus: settled.stop.status,
    deliveryId: settled.stop.deliveryId,
  } satisfies RouteRealtimeEvent);

  // The route ended on this stop. Nobody pressed a button, so nobody is
  // watching for a response — which is exactly why the board has to be told.
  if (settled.closedRoute) {
    sendRouteEventToBusiness(businessId, {
      type: "route.completed",
      routeId: settled.closedRoute.id,
      routeCode: settled.closedRoute.code,
    } satisfies RouteRealtimeEvent);
  }
}

export { announceStopSettled };
