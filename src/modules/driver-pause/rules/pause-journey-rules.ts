/**
 * When a pause may start (decision 14.4; design §5): only inside a journey,
 * that is, while the driver has a route RELEASED or IN_PROGRESS that day.
 *
 * Judged at the TAP, not at arrival: a start made offline at 12:02 during a
 * route may arrive at 18:00 with the route already completed, and it was a
 * pause of that journey (the same principle as occurred_at, MOB-08).
 */

type JourneyRouteStatus =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

interface JourneyRoute {
  id: string;
  status: JourneyRouteStatus;

  /**
   * When it was released to the driver. Routes released before the column
   * existed (or by a writer that does not stamp it yet) have null; their
   * stand-in is started_at, then updated_at (the migration's backfill).
   */
  released_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;

  /** "YYYY-MM-DD", the route's business day. */
  scheduled_date: string;
}

/** When the route reached the driver, with the backfill's stand-ins. */
function releasedAtOf(route: JourneyRoute): Date | null {
  if (route.released_at) return route.released_at;

  // Only a route that did leave PLANNED has a stand-in.
  if (route.status === "PLANNED") return null;

  if (route.started_at) return route.started_at;

  return route.status === "RELEASED" || route.status === "IN_PROGRESS"
    ? route.updated_at
    : null;
}

/**
 * Whether the route made a journey at `at`, whose business day (in the
 * company's zone) is `dayKey`:
 * - it had been released by then (IN_PROGRESS implies released);
 * - it had not finished by then (completed, or cancelled, after `at`);
 * - it was that day's route, or had already started (a night route that
 *   crosses midnight). A route released today for tomorrow is no journey today.
 */
function isJourneyRouteAt(
  route: JourneyRoute,
  at: Date,
  dayKey: string,
): boolean {
  const time = at.getTime();
  const released = releasedAtOf(route);

  if (!released || released.getTime() > time) return false;

  const notFinished =
    route.status === "RELEASED" ||
    route.status === "IN_PROGRESS" ||
    (route.status === "COMPLETED" &&
      (route.completed_at ?? route.updated_at).getTime() >= time) ||
    (route.status === "CANCELLED" && route.updated_at.getTime() >= time);

  if (!notFinished) return false;

  const started =
    route.started_at !== null && route.started_at.getTime() <= time;

  return route.scheduled_date === dayKey || started;
}

/**
 * The journey's route at `at`, or null: the one on the street first (latest
 * start), then the latest released. Pauses are pinned to it (routeId).
 */
function journeyRouteAt(
  routes: readonly JourneyRoute[],
  at: Date,
  dayKey: string,
): JourneyRoute | null {
  const eligible = routes.filter((route) =>
    isJourneyRouteAt(route, at, dayKey),
  );

  eligible.sort((a, b) => {
    const startA = a.started_at?.getTime() ?? -Infinity;
    const startB = b.started_at?.getTime() ?? -Infinity;

    if (startA !== startB) return startB - startA;

    const releasedA = releasedAtOf(a)?.getTime() ?? -Infinity;
    const releasedB = releasedAtOf(b)?.getTime() ?? -Infinity;

    if (releasedA !== releasedB) return releasedB - releasedA;

    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return eligible[0] ?? null;
}

export { isJourneyRouteAt, journeyRouteAt, releasedAtOf };
export type { JourneyRoute, JourneyRouteStatus };
