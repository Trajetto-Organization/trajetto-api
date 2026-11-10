import { RouteNotFoundError } from "@/modules/route/usecases/errors/route-errors";
import { VehicleChecklistArrivalBeforeRouteEndError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-before-route-end-error";
import { VehicleChecklistArrivalRouteOpenError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-arrival-route-open-error";
import { AppError } from "@/shared/errors/AppError";
import {
  isStopOpen,
  isTerminalRouteStatus,
  type RouteStatus,
  type RouteStopStatus,
} from "@/shared/route/route-rules";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import {
  ENDED_ROUTE_CHECKLIST_WINDOW_MS,
  routeHandsOverVehicle,
} from "@/shared/vehicle/driver-vehicle-access";

/**
 * What ties a vehicle checklist or a refuelling to a route (plan of
 * 02/11/2026, items C4, C5 and F3): the record is what happened to the
 * vehicle on that route, so the route must be the record's driver's and
 * carry the record's vehicle.
 *
 * The link never asks the route's status, on purpose: the app queues a
 * departure checklist with photos offline, and it may reach the server after
 * the route left or even ended. The server records it; only the app holds
 * "Iniciar rota" back until the checklist exists (decision D08). A route of
 * another company reads exactly like one that does not exist. The arrival
 * checklist is the one moment that asks more, and only of a driver's build
 * that holds it the same way (arrivalChecklistRefusal,
 * arrivalBeforeRouteEndRefusal).
 *
 * Whether that link also proves a DRIVER had the vehicle is another question
 * (routeProvesCustody): there the status and the record's date count.
 */

type ChecklistPhaseValue = "STANDALONE" | "ROUTE_START" | "ROUTE_END";

/** The few columns of a route this rule reads. */
interface LinkedRoute {
  driverId: string;
  vehicleId?: string | null;
}

/** Why this route cannot carry this record, or null when it can. */
function routeLinkRefusal(
  route: LinkedRoute | null,
  record: { driverId?: string | null; vehicleId: string },
): AppError | null {
  // The route module's 404 (DELIVERY_ROUTE_NOT_FOUND), never the router's
  // ROUTE_NOT_FOUND: the app's outbox reads that one as an outdated build
  // and would replay a queued checklist of a deleted route after every
  // upgrade instead of failing it on the merits.
  if (!route) return new RouteNotFoundError();

  if (record.driverId && route.driverId !== record.driverId) {
    return new AppError(
      "A rota informada é de outro motorista.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  if (!route.vehicleId) {
    return new AppError(
      "A rota informada ainda não tem veículo.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  if (route.vehicleId !== record.vehicleId) {
    return new AppError(
      "O veículo informado não é o veículo da rota.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  return null;
}

/** The route facts the custody proof reads. */
interface CustodyRoute {
  status: string;
  released_at?: Date | string | null;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  updated_at?: Date | string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whether the route a driver's record names proves the driver had the
 * vehicle when the record was made, standing in for the custody check
 * (canDriverOperateVehicle). Without this bound any old, cancelled or never
 * released route of the driver with truck X opened X to them for good: a
 * refuelling that moves X's odometer, a checklist that alerts the fleet,
 * while X is with somebody else today.
 *
 * - A released or running route hands the vehicle over: it proves custody,
 *   as canDriverOperateVehicle already says.
 * - A planned one is a draft and hands nothing over.
 * - An ended one (COMPLETED, CANCELLED) proves custody only if it ever handed
 *   the vehicle over (released or started) and only for a record dated from
 *   the day of that handover up to its end plus the arrival checklist
 *   window. The end is completed_at; a cancelled route has none, and its
 *   last update is when it was called off. The record's date is the one the
 *   app captured at the gesture (K6), so a record made during the route
 *   lands however late the phone syncs; a bare day is compared by the
 *   company's day, which is why the lower bound is the handover's day.
 *
 * False sends the caller back to canDriverOperateVehicle, never to a
 * refusal of its own: the responsible driver of X still records on X.
 */
function routeProvesCustody(
  route: CustodyRoute,
  recordDate: Date,
  timeZone: string | null | undefined,
): boolean {
  if (routeHandsOverVehicle(route.status)) return true;
  if (route.status !== "COMPLETED" && route.status !== "CANCELLED") {
    return false;
  }

  const handedOverAt = toDate(route.released_at) ?? toDate(route.started_at);
  const endedAt = toDate(route.completed_at) ?? toDate(route.updated_at);

  if (!handedOverAt || !endedAt || Number.isNaN(recordDate.getTime())) {
    return false;
  }

  const zone = resolveTimeZone(timeZone);

  if (businessDateKey(recordDate, zone) < businessDateKey(handedOverAt, zone)) {
    return false;
  }

  return (
    recordDate.getTime() <= endedAt.getTime() + ENDED_ROUTE_CHECKLIST_WINDOW_MS
  );
}

/**
 * A checklist names its moment (departure or arrival) exactly when it names
 * a route (C4, decision D09: one per route). A standalone one names neither.
 */
function checklistPhaseRefusal(
  routeId: string | null | undefined,
  phase: ChecklistPhaseValue | null | undefined,
): AppError | null {
  const routePhase = phase === "ROUTE_START" || phase === "ROUTE_END";

  if (routeId && !routePhase) {
    return new AppError(
      "Informe se o checklist é o de saída ou o de chegada da rota.",
      400,
      "CHECKLIST_ROUTE_PHASE_REQUIRED",
    );
  }

  if (!routeId && routePhase) {
    return new AppError(
      "Informe a rota do checklist de saída ou de chegada.",
      400,
      "CHECKLIST_ROUTE_REQUIRED",
    );
  }

  return null;
}

/** The route facts the arrival rule reads (a RouteWithStops has them). */
interface ArrivalRoute {
  status: RouteStatus;
  started_at?: Date | string | null;
  stops: ReadonlyArray<{
    status: RouteStopStatus;
    /** When a delivered or failed stop was resolved, by the fact (MOB-08). */
    completed_at?: Date | string | null;
  }>;
}

/**
 * The first app contract (`contract` in x-trajetto-client-version,
 * CLIENT_CONTRACT in trajetto-mobile/utils/client-version.ts) whose build
 * holds the arrival checklist until the route is resolved, and so the first
 * the server refuses an early one from.
 */
const ARRIVAL_CHECKLIST_RULE_CONTRACT = 5;

/**
 * Why the arrival checklist (ROUTE_END) cannot be made on this route yet, or
 * null when it can — and always null for any other moment: the departure
 * one keeps decision D08.
 *
 * The arrival is the end of the route's work, so it waits for the route to
 * have left (started_at, or a route already running or ended) and for EVERY
 * stop to be in a final status (COMPLETED, FAILED, CANCELLED; isStopOpen).
 * Every stop, not "the last delivery of the list": stops resolve in any
 * order, and the dispatcher may add stops to a running route (K12), which
 * opens it again. A route that ended has nothing open (its cancellation and
 * "Encerrar com pendências" call off the open stops), so its arrival opens.
 *
 * The refusal carries the open stops; the caller decides whom it applies to
 * (enforcesArrivalChecklistRule).
 */
function arrivalChecklistRefusal(
  phase: ChecklistPhaseValue | null | undefined,
  route: ArrivalRoute,
): VehicleChecklistArrivalRouteOpenError | null {
  if (phase !== "ROUTE_END") return null;

  const openStops = route.stops.filter((stop) => isStopOpen(stop.status));
  const started =
    toDate(route.started_at) !== null ||
    route.status === "IN_PROGRESS" ||
    isTerminalRouteStatus(route.status);

  if (started && openStops.length === 0) return null;

  return new VehicleChecklistArrivalRouteOpenError(openStops.length);
}

/**
 * How much later than an arrival checklist a stop may be resolved and still
 * count as resolved before it. Both instants are taps moved onto the
 * server's clock by their own request's send stamp (K6, MOB-08), so each
 * carries that request's delay — a proof sent on a slow signal reads a
 * little late. The same five minutes the driver's position allows a phone's
 * clock (driver-position-rules).
 */
const ARRIVAL_CHECKLIST_CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * Why an arrival checklist (ROUTE_END) that arrivalChecklistRefusal lets
 * through is still not the route's arrival, or null when it is — and always
 * null for any other moment.
 *
 * Every stop being final when the checklist reaches the server is not
 * enough: the checklist must have been made after the route's work ended.
 * One the phone saved offline before the dispatcher added a stop (K12), or
 * before it learnt of one, waits in the queue while that stop is open
 * (CHECKLIST_ARRIVAL_ROUTE_OPEN), and the driver then drives to it; a draft
 * held while the route reopened keeps its date. Taken once the stop is
 * resolved, it would record the vehicle — km, condition — from before the
 * last delivery as the route's arrival.
 *
 * So a stop COMPLETED or FAILED (the driver worked it: completed_at, the
 * fact's own instant) later than the checklist's date, past the clock slack,
 * refuses it for good. A stop CANCELLED after it does not: nobody drove to
 * it, and the checklist still shows the vehicle as the route left it.
 */
function arrivalBeforeRouteEndRefusal(
  phase: ChecklistPhaseValue | null | undefined,
  route: ArrivalRoute,
  checklistDate: Date,
): VehicleChecklistArrivalBeforeRouteEndError | null {
  if (phase !== "ROUTE_END" || Number.isNaN(checklistDate.getTime())) {
    return null;
  }

  const latest = checklistDate.getTime() + ARRIVAL_CHECKLIST_CLOCK_SLACK_MS;

  const laterStops = route.stops.filter((stop) => {
    if (stop.status !== "COMPLETED" && stop.status !== "FAILED") return false;

    const resolvedAt = toDate(stop.completed_at);

    return resolvedAt !== null && resolvedAt.getTime() > latest;
  }).length;

  return laterStops > 0
    ? new VehicleChecklistArrivalBeforeRouteEndError(laterStops)
    : null;
}

/**
 * Whether an early arrival checklist is refused for the build that sent it:
 * only from ARRIVAL_CHECKLIST_RULE_CONTRACT on. An older build (or one that
 * sends no x-trajetto-client-version, like the app in drivers' hands today)
 * lets the driver make it whenever, and its outbox would fail a refusal it
 * never offered to avoid: that one is recorded, and flagged in the trail
 * when a stop was still open. One dated before a stop resolved later
 * (arrivalBeforeRouteEndRefusal) is recorded as before, unflagged: mobile
 * `main` stamps its checklist with the phone's own clock, which nothing
 * corrects (K6 came later), and the comparison with the stops' instants
 * would accuse a phone set a few minutes behind.
 */
function enforcesArrivalChecklistRule(
  clientContract: number | null | undefined,
): boolean {
  return (
    typeof clientContract === "number" &&
    clientContract >= ARRIVAL_CHECKLIST_RULE_CONTRACT
  );
}

export {
  ARRIVAL_CHECKLIST_CLOCK_SLACK_MS,
  ARRIVAL_CHECKLIST_RULE_CONTRACT,
  arrivalBeforeRouteEndRefusal,
  arrivalChecklistRefusal,
  checklistPhaseRefusal,
  enforcesArrivalChecklistRule,
  routeLinkRefusal,
  routeProvesCustody,
};
export type { ArrivalRoute, ChecklistPhaseValue, CustodyRoute, LinkedRoute };
