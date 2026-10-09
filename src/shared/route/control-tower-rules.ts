/**
 * How the tower's numbers are computed, away from any query.
 *
 * Each of these is a judgement — what counts as late, what counts as finished,
 * what a day even is — and every one of them will be argued with by somebody
 * looking at the screen. Pure functions so the argument can be settled by
 * reading a test rather than by reading a SQL string.
 */

import { currentOnTheWayStopId } from "@/modules/route/usecases/mark-stop-on-the-way/on-the-way-rules";

import { isPositionFresh } from "./driver-position-rules";

/**
 * How late a departure has to be before it counts as late.
 *
 * Fifteen minutes. A route that left at 07:03 against a 07:00 plan did not
 * leave late by any standard an operation recognises, and a punctuality number
 * that said so would be a number nobody trusts — which is the same as not
 * having it.
 */
const DEPARTURE_GRACE_MINUTES = 15;

const DEPARTURE_GRACE_MS = DEPARTURE_GRACE_MINUTES * 60 * 1000;

/**
 * - `on_time` / `late`: it left, judged against the plan.
 * - `waiting`: it has not left and the planned hour (plus the grace) has not
 *   come yet. Not a verdict, so it stays out of the rate.
 * - `not_departed`: it has not left and the hour has passed. A late
 *   departure in progress, so it weighs on the rate as one.
 * - `not_planned`: no planned hour, so nothing to be late against.
 */
type DeparturePunctuality =
  | "on_time"
  | "late"
  | "waiting"
  | "not_departed"
  | "not_planned";

/**
 * Whether one route left on time, as of `now`.
 *
 * `now` matters: without it a route planned for 10:00 was already "não saiu"
 * at 06:00, and a route three hours late that never left was out of the rate
 * altogether — one on time plus four stuck in the yard read as 100%.
 */
function departurePunctuality(
  route: { planned_departure_at: Date | null; started_at: Date | null },
  now: Date,
): DeparturePunctuality {
  if (!route.planned_departure_at) return "not_planned";

  const deadline = route.planned_departure_at.getTime() + DEPARTURE_GRACE_MS;

  if (!route.started_at) {
    return now.getTime() > deadline ? "not_departed" : "waiting";
  }

  return route.started_at.getTime() > deadline ? "late" : "on_time";
}

interface PunctualitySummary {
  onTime: number;

  /** Left, but after the planned hour plus the grace. */
  late: number;

  /** Planned, the hour (plus the grace) has passed, and it has not left. */
  notDeparted: number;

  /** Planned for later today: not judged yet. */
  waiting: number;

  /** No planned hour at all — excluded from the rate, counted here. */
  notPlanned: number;

  /**
   * On time over everything that is already judgeable: the routes that left
   * and the ones whose hour passed without leaving. Null when none is: a rate
   * over zero routes is not 100%, it is unanswerable.
   */
  rate: number | null;
}

function summarisePunctuality(
  routes: Array<{ planned_departure_at: Date | null; started_at: Date | null }>,
  now: Date,
): PunctualitySummary {
  const summary: PunctualitySummary = {
    onTime: 0,
    late: 0,
    notDeparted: 0,
    waiting: 0,
    notPlanned: 0,
    rate: null,
  };

  for (const route of routes) {
    const verdict = departurePunctuality(route, now);

    if (verdict === "on_time") summary.onTime += 1;
    else if (verdict === "late") summary.late += 1;
    else if (verdict === "not_departed") summary.notDeparted += 1;
    else if (verdict === "waiting") summary.waiting += 1;
    else summary.notPlanned += 1;
  }

  const judged = summary.onTime + summary.late + summary.notDeparted;

  if (judged > 0) {
    summary.rate = Math.round((summary.onTime / judged) * 1000) / 10;
  }

  return summary;
}

/**
 * The funnel, in the order a document actually moves.
 *
 * Fixed and exhaustive rather than derived from whatever the query returned: a
 * status with no rows today has to show a zero, because "nenhuma entrega
 * falhou hoje" is the single best thing this screen can say and a funnel that
 * omitted the column would never say it.
 */
const FUNNEL_ORDER = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
] as const;

type FunnelStatus = (typeof FUNNEL_ORDER)[number];

const FUNNEL_LABELS: Record<FunnelStatus, string> = {
  PENDING: "Pendentes",
  IN_TRANSIT: "Em rota",
  DELIVERED: "Entregues",
  FAILED: "Insucesso",
  CANCELLED: "Canceladas",
};

function buildFunnel(
  counts: Array<{ status: string; total: number }>,
): Array<{ status: FunnelStatus; label: string; total: number }> {
  const found = new Map<string, number>();

  // Summed, not overwritten: the day's counts come per driver and status.
  for (const entry of counts) {
    found.set(entry.status, (found.get(entry.status) ?? 0) + entry.total);
  }

  return FUNNEL_ORDER.map((status) => ({
    status,
    label: FUNNEL_LABELS[status],
    total: found.get(status) ?? 0,
  }));
}

/**
 * How much of the day is done.
 *
 * "Finished" is DELIVERED plus FAILED plus CANCELLED resolved in the day
 * (decision 7.2): an insucesso is a result, not an interruption, and a
 * progress bar that only counted successes would sit at 80% forever on a day
 * where a fifth of the addresses were refused.
 */
const FINISHED_STATUSES: FunnelStatus[] = ["DELIVERED", "FAILED", "CANCELLED"];

function dayProgress(
  counts: Array<{ status: string; total: number }>,
): { finished: number; total: number; rate: number | null } {
  let finished = 0;
  let total = 0;

  for (const entry of counts) {
    if (!(FUNNEL_ORDER as readonly string[]).includes(entry.status)) continue;

    total += entry.total;

    if (FINISHED_STATUSES.includes(entry.status as FunnelStatus)) {
      finished += entry.total;
    }
  }

  return {
    finished,
    total,

    // Null and not zero on an empty day: nothing to do is not no progress, and
    // an empty bar at six in the morning reads as the operation being behind.
    rate: total > 0 ? Math.round((finished / total) * 1000) / 10 : null,
  };
}

/**
 * One driver's share of the day's active documents (decision 7.1).
 *
 * The monitoring board by driver used to read another definition: PENDING of
 * ANY date as "designadas", so tomorrow's load sat in today's denominator and
 * a driver done with the day read 60%. Folded from the same counts as the
 * tower's funnel, the two can no longer disagree. A document with no driver
 * is nobody's load, and a cancellation was taken off the driver, not
 * resolved by them — the same base as routeProgress.
 */
interface DriverDayLoad {
  driverId: string;

  /** PENDING on the day's routes (or on a route running now). */
  designated: number;

  /** IN_TRANSIT now. */
  inRoute: number;

  deliveredToday: number;
  failedToday: number;
}

function driverDayLoads(
  counts: ReadonlyArray<{ driverId: string | null; status: string; total: number }>,
): DriverDayLoad[] {
  const loads = new Map<string, DriverDayLoad>();

  const field: Record<string, keyof Omit<DriverDayLoad, "driverId"> | undefined> = {
    PENDING: "designated",
    IN_TRANSIT: "inRoute",
    DELIVERED: "deliveredToday",
    FAILED: "failedToday",
  };

  for (const { driverId, status, total } of counts) {
    const key = field[status];

    if (!driverId || !key || total <= 0) continue;

    const load = loads.get(driverId) ?? {
      driverId,
      designated: 0,
      inRoute: 0,
      deliveredToday: 0,
      failedToday: 0,
    };

    load[key] += total;
    loads.set(driverId, load);
  }

  return [...loads.values()];
}

/**
 * How long a finished route's truck stays on the map (decision 7.2).
 *
 * The phone stops reporting when the route ends, so the dot ages like a phone
 * without signal. Two hours with its own look ("concluída") answers "where did
 * it end?"; after that it leaves the map instead of inflating "sem reportar".
 */
const ENDED_ROUTE_VISIBLE_MS = 2 * 60 * 60 * 1000;

type TowerRouteStatus =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/**
 * - `moving`: the route runs and the phone reported in the last ten minutes;
 * - `silent`: the route runs and the phone went quiet (the "sem reportar"
 *   badge counts only these);
 * - `ended`: the route finished (or was cancelled) under two hours ago.
 */
type TowerVehicleState = "moving" | "silent" | "ended";

interface TowerRouteRef {
  id: string;
  driverId: string;
  status: TowerRouteStatus | string;

  /** completed_at, or the cancellation moment. Null while it runs. */
  ended_at: Date | null;
}

interface PlacedVehicle<R extends TowerRouteRef> {
  state: TowerVehicleState;
  route: R;
}

/**
 * Which route a driver's last position belongs to on the map, and how to draw
 * it — or null when it should not be drawn at all.
 *
 * The driver's running route wins over the position's own route id: a point
 * recorded before the departure is stored without a route (routeOfPing), and
 * that truck is still the one on this route. With nothing running, the most
 * recent ended route within the window explains the dot; past it, the dot is
 * a phone at home and leaves the map.
 */
function placeVehicle<R extends TowerRouteRef>(
  position: { driverId: string; routeId: string | null; recorded_at: Date },
  routes: readonly R[],
  now: Date,
): PlacedVehicle<R> | null {
  const own = routes.filter((route) => route.driverId === position.driverId);

  const running = own.find((route) => route.status === "IN_PROGRESS");

  if (running) {
    return {
      state: isPositionFresh(position.recorded_at, now) ? "moving" : "silent",
      route: running,
    };
  }

  const ended = own
    .filter(
      (route) =>
        (route.status === "COMPLETED" || route.status === "CANCELLED") &&
        route.ended_at !== null &&
        now.getTime() - route.ended_at.getTime() <= ENDED_ROUTE_VISIBLE_MS,
    )
    .sort(
      (a, b) =>
        // The route the point was recorded on first, then the latest to end.
        Number(b.id === position.routeId) - Number(a.id === position.routeId) ||
        (b.ended_at as Date).getTime() - (a.ended_at as Date).getTime(),
    );

  if (ended.length === 0) return null;

  return { state: "ended", route: ended[0] };
}

/**
 * How far a route got, from its stops (decision 6.6, DLVP-MON-2).
 *
 * `completion` counts insucessos as resolved: a driver with three delivered
 * and seven refused is done with ten, not at 100% after three. `delivered`
 * is the success share of the same base. Cancelled stops leave the base —
 * they were taken off the route, not resolved on it.
 */
interface RouteStopLike {
  id: string;
  status: string;
  on_the_way_at?: Date | null;
}

interface RouteProgress {
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  cancelled: number;

  /** Of the pending ones, the driver is at the door. */
  arrived: number;

  /**
   * Of the pending ones, the one the driver is heading to (decision 6.4): at
   * most one, the stop holding the route's latest mark while it is PENDING
   * (currentOnTheWayStopId), as the web board and the app read it.
   */
  onTheWay: number;

  /** (delivered + failed) / (total − cancelled), in %; null with no stops. */
  completion: number | null;

  /** delivered / (total − cancelled), in %; null with no stops. */
  deliveredRate: number | null;
}

function routeProgress(stops: readonly RouteStopLike[]): RouteProgress {
  const progress: RouteProgress = {
    total: stops.length,
    delivered: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    arrived: 0,
    onTheWay: 0,
    completion: null,
    deliveredRate: null,
  };

  const onTheWayStopId = currentOnTheWayStopId(
    stops.map(({ id, status, on_the_way_at }) => ({ id, status, on_the_way_at })),
  );

  for (const stop of stops) {
    if (stop.status === "COMPLETED") progress.delivered += 1;
    else if (stop.status === "FAILED") progress.failed += 1;
    else if (stop.status === "CANCELLED") progress.cancelled += 1;
    else {
      progress.pending += 1;

      if (stop.status === "ARRIVED") progress.arrived += 1;
      else if (stop.id === onTheWayStopId) progress.onTheWay += 1;
    }
  }

  const base = progress.total - progress.cancelled;

  if (base > 0) {
    const percent = (value: number) => Math.round((value / base) * 1000) / 10;

    progress.completion = percent(progress.delivered + progress.failed);
    progress.deliveredRate = percent(progress.delivered);
  }

  return progress;
}

/**
 * The "últimos eventos" feed: several sources, one list.
 *
 * Newest by arrival first, like the delivery events always were: an offline
 * proof synced now is news now, and it is shown with the hour it happened.
 * The id breaks ties so two refreshes never swap equal rows.
 */
function mergeFeed<T extends { id: string; receivedAt: Date }>(
  sources: ReadonlyArray<readonly T[]>,
  limit: number,
): T[] {
  return sources
    .flat()
    .sort(
      (a, b) =>
        b.receivedAt.getTime() - a.receivedAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .slice(0, limit);
}

export {
  DEPARTURE_GRACE_MINUTES,
  ENDED_ROUTE_VISIBLE_MS,
  FINISHED_STATUSES,
  FUNNEL_LABELS,
  FUNNEL_ORDER,
  buildFunnel,
  dayProgress,
  departurePunctuality,
  driverDayLoads,
  mergeFeed,
  placeVehicle,
  routeProgress,
  summarisePunctuality,
  type DeparturePunctuality,
  type DriverDayLoad,
  type FunnelStatus,
  type PlacedVehicle,
  type PunctualitySummary,
  type RouteProgress,
  type TowerRouteRef,
  type TowerRouteStatus,
  type TowerVehicleState,
};
