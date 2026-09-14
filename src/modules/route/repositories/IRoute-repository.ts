import type {
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  Route,
  RouteStop,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
} from "../dtos/route-dto";

interface IRouteRepository {
  /**
   * Creates the route, allocates its per-company code and turns the given
   * deliveries into stops — all in one transaction.
   *
   * Throws DeliveryAlreadyOnRouteError when any delivery already has an open
   * stop, and writes nothing: a half-created route is worse than none, because
   * the dispatcher would have to find and undo it.
   */
  createRoute: (data: CreateRouteProps) => Promise<RouteWithStops>;

  updateRoute: (routeId: string, data: UpdateRouteProps) => Promise<Route>;

  findRouteById: (routeId: string) => Promise<RouteWithStops | null>;

  /**
   * The route a driver is expected to be working: the one in progress, or the
   * released one for today. Null when there is none.
   */
  findDriverRoute: (
    businessId: string,
    driverId: string,
  ) => Promise<RouteWithStops | null>;

  listRoutes: (props: ListRoutesProps) => Promise<ListRoutesResult>;

  /**
   * Moves a route, but only from `transition.expectedStatus`.
   *
   * Throws RouteStatusConflictError (writing nothing) when the row already
   * moved, and RouteVehicleBusyError when the departure would put a second
   * route in progress on the same vehicle.
   *
   * Mirrors driverId/vehicleId onto the deliveries of the route's open stops,
   * because those columns are the route's shadow and this is their only
   * writer.
   */
  transitionRoute: (
    routeId: string,
    transition: RouteTransition,
  ) => Promise<Route>;

  /** Appends deliveries as stops at the end of the route's current order. */
  addStops: (routeId: string, deliveryIds: string[]) => Promise<RouteStop[]>;

  /** Removes a stop and releases its delivery back to the unassigned pool. */
  removeStop: (routeId: string, stopId: string) => Promise<void>;

  /**
   * Rewrites the whole manual order. `orderedStopIds` must name exactly the
   * route's current stops; anything else means the caller was looking at a
   * stale route and the whole write is refused.
   */
  reorderStops: (routeId: string, orderedStopIds: string[]) => Promise<void>;

  /**
   * Closes the route if no stop is open any more. Returns the route when it
   * closed, null when there was still work left.
   *
   * Called after every stop outcome. Idempotent: a route already COMPLETED
   * returns null rather than failing, because the outbox may resend the event
   * that triggered it.
   */
  closeRouteIfFinished: (routeId: string) => Promise<Route | null>;
}

export type { IRouteRepository };
