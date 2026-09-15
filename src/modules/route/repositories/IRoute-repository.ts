import type { Prisma } from "@prisma/client";

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

/**
 * Every method that reaches a route takes the `businessId` alongside the id,
 * and every one of them puts it in the `where`.
 *
 * This is deliberate duplication of a check the use cases already make. The
 * use case protects the path somebody remembered to protect; the `where`
 * protects the ones nobody thought about — a new controller wired straight to
 * the repository, a background job, a script, the spreadsheet importer of the
 * next slice. A tenant guard that lives only above the data layer is a guard
 * that holds until the first caller that skips it, and it fails open.
 *
 * Reaching a route from the wrong company reads exactly like reaching one that
 * does not exist: the write matches no row, the read answers null. That is
 * also why the use cases answer 404 rather than 403 — a different refusal for
 * "exists but is not yours" tells an attacker which ids are real.
 */
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

  /**
   * Throws RouteStatusConflictError when the route does not exist, belongs to
   * another company, or no longer holds `expectedStatus`. Editing is only
   * legal while the route has not been executed.
   */
  updateRoute: (
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,
  ) => Promise<Route>;

  findRouteById: (
    routeId: string,
    businessId: string,
  ) => Promise<RouteWithStops | null>;

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
   * Moves a route, but only from `transition.expectedStatus` and only within
   * `businessId`.
   *
   * Throws RouteStatusConflictError (writing nothing) when the row already
   * moved, and RouteVehicleBusyError when the departure would put a second
   * route in progress on the same vehicle.
   *
   * Mirrors driverId/vehicleId onto the deliveries of the route's open stops,
   * because those columns are the route's shadow and this is their only
   * writer, and moves Vehicle.status in or out of IN_ROUTE.
   *
   * Takes the caller's transaction so a notification about the move can be
   * published in the same commit: the outbox event has to exist if and only if
   * the write landed, or a driver gets told about a release that rolled back.
   */
  transitionRoute: (
    routeId: string,
    businessId: string,
    transition: RouteTransition,
    tx?: Prisma.TransactionClient,
  ) => Promise<Route>;

  /** Appends deliveries as stops at the end of the route's current order. */
  addStops: (
    routeId: string,
    businessId: string,
    deliveryIds: string[],
  ) => Promise<RouteStop[]>;

  /** Removes a stop and releases its delivery back to the unassigned pool. */
  removeStop: (
    routeId: string,
    businessId: string,
    stopId: string,
  ) => Promise<void>;

  /**
   * Rewrites the whole manual order. `orderedStopIds` must name exactly the
   * route's current stops; anything else means the caller was looking at a
   * stale route and the whole write is refused.
   */
  reorderStops: (
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
  ) => Promise<void>;

  /**
   * Records the outcome of the stop a delivery currently occupies, and closes
   * the route when nothing is left open.
   *
   * Addressed by DELIVERY, not by stop id, and that is the whole point: the
   * driver acts on a delivery — arrived, proved it, reported a problem — and
   * the stop is the route's view of that same act. An endpoint that moved a
   * stop directly would be a second writer for one fact, and the two would
   * drift the first time somebody used it.
   *
   * `from` is the set of stop statuses the outcome may legally come from. It
   * is a set rather than one value because a proof legitimately arrives at a
   * stop that was never marked ARRIVED: the driver worked the whole street
   * offline and the app only ever got to send the proof.
   *
   * Answers null — never throws — when the delivery has no stop in `from` on
   * an in-progress route of this company. That is the ordinary case for a
   * delivery that is not on a route at all, and the idempotent case for an
   * outbox resend. The delivery outcome is the fact; the stop follows it, and
   * a route that has nothing to say must not undo a proof.
   *
   * At most one row can match: `route_stop_active_delivery_idx` allows a
   * delivery exactly one open stop, and `from` only ever names open statuses.
   *
   * Takes the caller's transaction so the stop resolves in the same commit as
   * the delivery outcome that caused it. Split apart, a crash in between
   * leaves a DELIVERED delivery on a PENDING stop: the route never closes,
   * because closing is triggered by a stop resolving and no stop resolves
   * again — and the delivery stays locked out of every future route by the
   * same partial unique index.
   */
  settleStopForDelivery: (
    deliveryId: string,
    businessId: string,
    outcome: {
      from: RouteStop["status"][];
      status: RouteStop["status"];
      arrived_at?: Date;
      completed_at?: Date;
    },
    tx?: Prisma.TransactionClient,
  ) => Promise<{ stop: RouteStop; closedRoute: Route | null } | null>;

  findStopById: (
    stopId: string,
    businessId: string,
  ) => Promise<(RouteStop & { route: Route }) | null>;
}

export type { IRouteRepository };
