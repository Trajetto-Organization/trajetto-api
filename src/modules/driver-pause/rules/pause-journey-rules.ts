/**
 * When a pause may start (decision 14.4, revised 12/11/2026): only while the
 * driver has a route of their own that is STARTED — started_at stamped by
 * "Iniciar rota", so IN_PROGRESS — and not finished yet. A route that was
 * only released (RELEASED, no departure) no longer makes a journey: the owner
 * saw drivers pause before the departure checklist and before leaving.
 *
 * The departure checklist is covered transitively: the app holds "Iniciar
 * rota" until it exists when the company requires it, and the server never
 * checks it (D08, src/shared/vehicle/route-link.ts: a checklist with photos
 * made offline may land after the start). Nor does this rule.
 *
 * Judged at the TAP, not at arrival: a start made offline at 12:02 during a
 * route may arrive at 18:00 with the route already completed, and it was a
 * pause of that journey (the same principle as occurred_at, MOB-08). The day
 * plays no part: a started route counts whatever its scheduled date (a night
 * route that crosses midnight, a route left open).
 *
 * The cases the driver's app runs against its own gate are in
 * tests/unitaires/driver-pause/fixtures/pause-journey-cases.json.
 */

type JourneyRouteStatus =
  "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

interface JourneyRoute {
  id: string;
  status: JourneyRouteStatus;

  /** Stamped once, by the departure (RELEASED → IN_PROGRESS); never cleared. */
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

/**
 * Clock slack between the departure and the pause: each is corrected by its
 * own X-Client-Sent-At, and the departure falls back to its receipt time when
 * the tap reads before the route existed, so a pause tapped seconds after
 * "Iniciar rota" can resolve to just before started_at. Technical only: the
 * app never offers the pause before the departure.
 */
const PAUSE_ROUTE_START_SLACK_MS = 2 * 60_000;

/**
 * Whether the route made a journey at `at`:
 * - it had started by then (started_at, with the clock slack);
 * - it had not finished by then (in progress, or completed or cancelled at
 *   or after `at`). A cancelled route has no completed_at: it left the
 *   street when it was cancelled, which is its updated_at.
 */
function isJourneyRouteAt(route: JourneyRoute, at: Date): boolean {
  const time = at.getTime();

  const started =
    route.started_at !== null &&
    route.started_at.getTime() <= time + PAUSE_ROUTE_START_SLACK_MS;

  if (!started) return false;

  return (
    route.status === "IN_PROGRESS" ||
    (route.status === "COMPLETED" &&
      (route.completed_at ?? route.updated_at).getTime() >= time) ||
    (route.status === "CANCELLED" && route.updated_at.getTime() >= time)
  );
}

/**
 * The journey's route at `at`, or null: the latest started, then the greater
 * id. Pauses are pinned to it (routeId).
 */
function journeyRouteAt(
  routes: readonly JourneyRoute[],
  at: Date,
): JourneyRoute | null {
  const eligible = routes.filter((route) => isJourneyRouteAt(route, at));

  // Every eligible route has started_at; the release no longer ranks.
  eligible.sort((a, b) => {
    const startA = a.started_at?.getTime() ?? -Infinity;
    const startB = b.started_at?.getTime() ?? -Infinity;

    if (startA !== startB) return startB - startA;

    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return eligible[0] ?? null;
}

export { PAUSE_ROUTE_START_SLACK_MS, isJourneyRouteAt, journeyRouteAt };
export type { JourneyRoute, JourneyRouteStatus };
