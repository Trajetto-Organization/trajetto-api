import {
  sendDriverPositionToBusiness,
  sendRouteEventToBusiness,
  type DriverPositionEvent,
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
    // The board patches its dot from this frame: without the instant it lost
    // "às HH:mm" until its next refetch.
    completedAt: settled.stop.completed_at
      ? new Date(settled.stop.completed_at).toISOString()
      : null,
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

  // The customers' systems hear about the same closure through
  // `announceRouteClosed`, which each of the four call sites invokes with its
  // own injected fan-out service. Sockets and webhooks are different
  // lifetimes — one is a frame nobody retries, the other a queued row that
  // must share the caller's commit — and a function doing both would have to
  // be async for the half that is, in a path where nothing else is.
}

export {
  announceStopSettled,
  sendDriverPositionToBusiness,
  type DriverPositionEvent,
};
