import type { RouteStatus } from "@/shared/route/route-rules";

/** The route fields that decide whether its write moved its vehicle. */
interface VehicleRoute {
  vehicleId?: string | null;
  status: RouteStatus;
  started_at?: Date | string | null;
}

/**
 * Whether a route in this state moved its vehicle's status — the rule
 * syncVehicleStatus (route-repository) writes by: the departure takes the
 * truck out (IN_ROUTE), and only the end of a route that LEFT gives it back.
 * A release, a pull back to planning or the cancellation of a route that
 * never left touches no vehicle.
 */
function routeMovesVehicle(route: VehicleRoute): boolean {
  if (!route.vehicleId) return false;

  if (route.status === "IN_PROGRESS") return true;

  return (
    (route.status === "COMPLETED" || route.status === "CANCELLED") &&
    Boolean(route.started_at)
  );
}

export { routeMovesVehicle };
export type { VehicleRoute };
