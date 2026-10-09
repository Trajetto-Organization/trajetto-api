import type { Prisma } from "@prisma/client";

import type {
  AssignmentContext,
  AssignmentPreview,
  AssignmentPreviewProps,
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  OpenStopRoute,
  PinnedLocation,
  DetachResult,
  PlanBump,
  PlanReordered,
  PlanStopsAdded,
  PlanStopsRemoved,
  PlanWriteOptions,
  Route,
  RouteStop,
  RouteStopWithDelivery,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
  VisitedPoint,
} from "../dtos/route-dto";
import type {
  UnroutedDeliveriesPage,
  UnroutedDeliveriesQuery,
} from "../usecases/list-unrouted-deliveries/unrouted-deliveries";

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
  createRoute: (
    data: CreateRouteProps,

    /**
     * The caller's transaction, when it has one, so the route and the
     * `delivery.assigned` events it announces commit together. With one, the
     * per-company code collision is reported as RouteCodeTakenError instead
     * of being retried — an aborted transaction cannot be continued.
     */
    outerTx?: Prisma.TransactionClient,
  ) => Promise<RouteWithStops>;

  /**
   * Takes deliveries off the routes they are on, so they can join another.
   *
   * Reassignment is an ordinary morning: a driver calls in sick and twelve
   * documents move to somebody else. A delivery may only hold one open stop
   * at a time — the database enforces it — so moving one means releasing the
   * stop it has.
   *
   * Only while the route has NOT left. Once it is IN_PROGRESS the stop is a
   * record of what the driver is doing, and silently cancelling it would
   * rewrite that; those ids come back in `blocked` for the caller to refuse
   * by name. Nothing is written when anything is blocked.
   *
   * The routes are locked before the decision (a departure committing in the
   * same instant is waited for, then seen), and `emptiedRoutes` are the
   * routes this left with no stop at all. Takes the caller's transaction so a
   * reassignment can detach, build and release as one unit of work.
   */
  detachFromOpenRoutes: (
    deliveryIds: string[],
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<DetachResult>;

  /**
   * Where these deliveries sit now, read without writing anything.
   *
   * `holder` is the route whose open stops are exactly these deliveries —
   * every one of them on it, and nothing else open on it — or null. It is
   * how the batch assignment recognises its own resend: the first call
   * committed and its response was lost, and rebuilding would leave that
   * first route released and empty and wake the driver twice.
   *
   * `blocked` names the deliveries whose open stop is on a route that already
   * left, the same list `detachFromOpenRoutes` refuses with — asked first so
   * that refusal wins over the generic "not pending" one.
   */
  inspectOpenStops: (
    deliveryIds: string[],
    businessId: string,
  ) => Promise<{ holder: Route | null; blocked: string[] }>;

  /**
   * Throws RouteStatusConflictError when the route does not exist, belongs to
   * another company, or no longer holds `expectedStatus`. Editing is only
   * legal while the route has not been executed.
   */
  updateRoute: (
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,

    /**
     * The caller's transaction, so the `delivery.assigned` events a new
     * driver or vehicle means commit with the change. Without one the write
     * runs in a transaction of its own.
     */
    tx?: Prisma.TransactionClient,

    /**
     * The version the dispatcher read (RoutePlanStaleError on a mismatch,
     * checked under the row lock). Every update moves plan_version.
     */
    options?: PlanWriteOptions,
  ) => Promise<Route>;

  findRouteById: (
    routeId: string,
    businessId: string,

    /** Read inside the caller's transaction, after its own write. */
    tx?: Prisma.TransactionClient,
  ) => Promise<RouteWithStops | null>;

  /**
   * The route a driver is expected to be working: the one in progress, or the
   * released one for today. Null when there is none.
   */
  findDriverRoute: (
    businessId: string,
    driverId: string,
  ) => Promise<RouteWithStops | null>;

  /**
   * The driver's route that is running right now, as its id and departure
   * only. For the position flush, which needs nothing else and runs for
   * every driver on the road every two minutes: findDriverRoute rebuilds the
   * route with every stop and delivery.
   *
   * Ordered exactly like findDriverRoute's IN_PROGRESS branch — day, then
   * creation, then id — so the two agree on "the" route even on a tie.
   */
  findActiveRouteForDriver: (
    businessId: string,
    driverId: string,
  ) => Promise<{ id: string; started_at: Date | null } | null>;

  /**
   * The company's zone (Business.timezone, resolved: an unknown or missing
   * value is the default). What "the route's day" and "today" are read in.
   */
  businessTimeZone: (businessId: string) => Promise<string>;

  /**
   * The company's zone and whether it has the FLEET module, in one read: the
   * assignment preview needs both before it reads anything else.
   */
  assignmentContext: (businessId: string) => Promise<AssignmentContext>;

  /**
   * Refuses a departure while the driver has ANOTHER route in progress
   * (FLEET-ASSIGN-3), throwing RouteDriverBusyError.
   *
   * Called inside the departure's transaction, before the transition, and it
   * takes a per-driver transaction lock first: two departures of two
   * released routes of the same driver queue here, and the second one reads
   * the first one's committed IN_PROGRESS row and is refused. Without the
   * lock both read "nothing running" and both left.
   */
  assertDriverFreeToDepart: (
    driverId: string,
    businessId: string,
    routeId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;

  /**
   * The driver's status, read with FOR SHARE inside the caller's route
   * write, or null when the row is not the company's.
   *
   * Deactivating a driver locks the row FOR UPDATE while it counts the open
   * routes (decision 8.3). A route writer that read the status before its
   * transaction could still add a route for a driver deactivated in between;
   * with the shared lock it waits for that commit and reads INACTIVE.
   */
  lockDriverStatus: (
    driverId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<string | null>;

  /**
   * What the assignment dialog needs to warn about a driver/vehicle pair
   * before it is chosen: who is responsible for the vehicle, the vehicles
   * this driver is responsible for, and the routes either one already has
   * running or on the same day. Reads only; tenant-scoped in every `where`.
   *
   * At most two queries in flight (tests/E2E/route-connection-fan-out): the
   * three dialogs ask it on every driver, vehicle, day or selection change.
   * A driver or vehicle that is not the company's ends the read there.
   */
  assignmentPreview:(props: AssignmentPreviewProps) => Promise<AssignmentPreview>;

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

  /**
   * Appends deliveries as stops at the end of the route's current order.
   *
   * Under the route lock: refuses a stale `expectedPlanVersion`
   * (RoutePlanStaleError) and a route that would pass ROUTE_MAX_STOPS open
   * stops (RouteStopsLimitError); bumps plan_version and writes one
   * ROUTE_ADDED timeline event per delivery, in the same commit.
   */
  addStops: (
    routeId: string,
    businessId: string,
    deliveryIds: string[],

    /**
     * The caller's transaction, so the `delivery.assigned` events for the new
     * stops commit with them. The route row is locked in it.
     */
    outerTx?: Prisma.TransactionClient,
    options?: PlanWriteOptions,
  ) => Promise<PlanStopsAdded>;

  /**
   * Removes PENDING stops of a route that has not left, and releases their
   * deliveries back to the unassigned pool. Ids that are not pending stops of
   * this route come back in `alreadyGone` (a retry is harmless). Throws
   * RouteStatusConflictError when the route is gone, foreign or has left.
   */
  removeStops: (
    routeId: string,
    businessId: string,
    stopIds: string[],
    options?: PlanWriteOptions,
  ) => Promise<PlanStopsRemoved>;

  /**
   * Rewrites the whole manual order. `orderedStopIds` must name exactly the
   * route's current stops; anything else means the caller was looking at a
   * stale route and the whole write is refused. The order it already has is
   * a no-op (`changed: false`, no version bump).
   */
  reorderStops: (
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
    options?: PlanWriteOptions,
  ) => Promise<PlanReordered>;

  /**
   * Locks these routes FOR UPDATE in id order, inside the caller's
   * transaction — the order detachFromOpenRoutes takes, so a move across two
   * routes and its mirror image queue instead of deadlocking.
   */
  lockRoutes: (
    routeIds: string[],
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<void>;

  /** plan_version + 1 on each route (tenant-scoped), inside the caller's lock. */
  bumpPlanVersions: (
    routeIds: string[],
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<PlanBump[]>;

  /**
   * The timeline lines of a plan change (ROUTE_ADDED / ROUTE_REMOVED), in
   * the caller's transaction. addStops and removeStops write their own; this
   * is for a move, whose detach happens elsewhere.
   */
  recordPlanEvents: (
    tx: Prisma.TransactionClient,
    rows: Array<{ deliveryId: string; note: string }>,
    meta: {
      type: "ROUTE_ADDED" | "ROUTE_REMOVED";
      routeId: string;
      businessId: string;
      actorId?: string | null;
    },
  ) => Promise<void>;

  /** The route a panel create with this Idempotency-Key already made. */
  findRouteBySubmission: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<RouteWithStops | null>;

  /**
   * Pins (or clears, with null) the delivery's address point (D7). Null when
   * the delivery is not the company's; `locked` when it is DELIVERED or
   * CANCELLED. Bumps the plan of the editable route holding it.
   */
  pinDeliveryLocation: (
    deliveryId: string,
    businessId: string,
    point: { latitude: number; longitude: number } | null,
  ) => Promise<PinnedLocation | null>;

  /**
   * Which route holds each of these deliveries right now (an open stop),
   * through the route's tenant. Deliveries on no route are absent.
   */
  findOpenStopRoutes: (
    deliveryIds: string[],
    businessId: string,
  ) => Promise<OpenStopRoute[]>;

  /** Arrival/proof GPS captured on this route, for the map. */
  listVisitedPoints: (
    routeId: string,
    businessId: string,
  ) => Promise<VisitedPoint[]>;

  /** PENDING deliveries with no open stop (D3), for the route picker. */
  listUnroutedDeliveries: (
    query: UnroutedDeliveriesQuery,
  ) => Promise<UnroutedDeliveriesPage>;

  /**
   * The deliveries that left with the route: its open stops whose delivery is
   * IN_TRANSIT, in the driver's order.
   *
   * Read inside the departure's own transaction, AFTER the transition, so the
   * "saiu para entrega" messages describe the load the commit actually put on
   * the street — not the route as it was read before the write (a stop removed
   * in between, a delivery cancelled on a released route).
   */
  listDepartedDeliveries: (
    routeId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<RouteStopWithDelivery["delivery"][]>;

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
   * One more case answers null after writing: a delivery done with (a
   * terminal outcome — not an arrival, and not a return to pending, which on
   * a plan is just the state it already had) whose open stop is still on a
   * route that has NOT left. That stop comes off the plan and the shadow is
   * cleared, as removeStop does — otherwise the departure carried an address
   * nobody could ever resolve and the route never closed.
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

      /** Clears the delivery's driver/vehicle shadow with the stop. */
      releaseDelivery?: boolean;

      /**
       * Called when a terminal outcome took the delivery off a plan that had
       * not left (its version moved). The caller announces it after commit.
       */
      onPlanDropped?: (bump: PlanBump) => void;
    },
    tx?: Prisma.TransactionClient,
  ) => Promise<{ stop: RouteStop; closedRoute: Route | null } | null>;

  /**
   * Locks the running route this delivery is an open stop of, and returns its
   * id (null when there is none). Called FIRST in every transaction that
   * writes a delivery and then settles its stop, so that transaction takes
   * the route before the delivery — the same order a route cancellation
   * takes them in (route → stops → deliveries). Opposite orders deadlocked.
   */
  lockRouteOfOpenStop: (
    deliveryId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<string | null>;

  /**
   * How many routes reference this driver or this vehicle, of any status.
   *
   * Asked before a hard delete. Deliberately counts EVERY route, not only the
   * running ones: a completed route is the record of a day's work, and the
   * point of the guard is precisely that deleting the person or the truck
   * would erase whose day it was.
   *
   * Not scoped by tenant, on purpose and unlike everything else in this
   * interface: the caller has already proven the driver or vehicle is theirs,
   * and a count scoped to one company would answer zero for a reference from
   * another — which is the one answer that must never be wrong here.
   */
  countRoutesReferencing: (reference: {
    driverId?: string;
    vehicleId?: string;
  }) => Promise<number>;

  findStopById: (
    stopId: string,
    businessId: string,
  ) => Promise<(RouteStop & { route: Route }) | null>;
}

export type { IRouteRepository };
