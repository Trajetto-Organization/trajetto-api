import {
  businessDateKey,
  businessDayRange,
  dateOnlyFromKey,
} from "@/shared/time/business-day";
import { OPEN_STOP_STATUSES } from "./route-rules";

/**
 * A route forgotten "Em andamento" (decision D26, plan of 02/11/2026: H3,
 * J4, K11).
 *
 * A route closes itself when its last stop is resolved, and nothing else
 * closed it: a driver who never resolved the last stop left the route
 * running for days — "Rota 1 de 30/10" counted as today on the tower, held
 * the driver and the truck busy (ROUTE_DRIVER_BUSY) and made the pause
 * report read "14:57–agora · 73 h". One rule says when such a route is a
 * forgotten one, so the tower's badge, the monitoring board, the pause
 * report's alert and the hourly job that warns the admins never disagree.
 *
 * Left open = started before the company's today (its own zone, never the
 * server's), or running for more than ROUTE_LEFT_OPEN_HOURS: a night route
 * that leaves at 23:00 is "yesterday's" by 00:00, and a route that left at
 * 00:30 is still a long one at 17:00.
 */
const ROUTE_LEFT_OPEN_HOURS = 16;

const LEFT_OPEN_MS = ROUTE_LEFT_OPEN_HOURS * 60 * 60 * 1000;

function isRouteLeftOpen(
  startedAt: Date | null,
  timeZone: string,
  now: Date,
): boolean {
  if (!startedAt) return false;

  return (
    businessDateKey(startedAt, timeZone) < businessDateKey(now, timeZone) ||
    now.getTime() - startedAt.getTime() > LEFT_OPEN_MS
  );
}

/**
 * The same rule as one instant: a running route is left open exactly when
 * it started before this — the later of the company's midnight and now −
 * 16 h (a departure before midnight is an earlier day; one before now − 16 h
 * is a long one). A query can then pick the routes left open by a range on
 * `started_at` instead of reading every running route to judge it; the
 * equivalence with isRouteLeftOpen is tested instant by instant.
 */
function leftOpenStartedBefore(timeZone: string, now: Date): Date {
  const midnight = businessDayRange(now, timeZone).start.getTime();

  return new Date(Math.max(midnight, now.getTime() - LEFT_OPEN_MS));
}

/**
 * What a screen inherited from routes left open (H3): the funnel, the
 * operation summary and the deliveries list's cards count those routes'
 * open stops as "Em rota" today, and the note reads "inclui N de rotas
 * abertas desde dd/mm". `open` is the route's open stops that the screen
 * counts (all of them on the tower; only the list's matches on a filtered
 * list); a route with none is not named.
 */
interface InheritedOpenStops {
  routes: number;
  deliveries: number;

  /** The oldest departure among them (ISO); null when there is none. */
  since: string | null;
}

function inheritedOpenStops(
  routes: ReadonlyArray<{ started_at: Date | null; open: number }>,
): InheritedOpenStops {
  const holding = routes.filter((route) => route.open > 0);

  const oldest = holding
    .map((route) => route.started_at)
    .filter((startedAt): startedAt is Date => startedAt !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    routes: holding.length,
    deliveries: holding.reduce((total, route) => total + route.open, 0),
    since: oldest?.toISOString() ?? null,
  };
}

/**
 * The tower's reading of it: of the running routes (with their stops' status,
 * as listTowerRoutes hands them over), the ones left open and their PENDING
 * or ARRIVED stops. The tower and the operation summary both answer with it.
 */
function inheritedFromRunningRoutes(
  running: ReadonlyArray<{
    started_at: Date | null;
    stops: ReadonlyArray<{ status: string }>;
  }>,
  timeZone: string,
  now: Date,
): InheritedOpenStops {
  return inheritedOpenStops(
    running
      .filter((route) => isRouteLeftOpen(route.started_at, timeZone, now))
      .map((route) => ({
        started_at: route.started_at,
        open: route.stops.filter((stop) =>
          (OPEN_STOP_STATUSES as readonly string[]).includes(stop.status),
        ).length,
      })),
  );
}

/** Calendar days between the departure and now, in the company's zone. */
function leftOpenDays(startedAt: Date, timeZone: string, now: Date): number {
  const from = dateOnlyFromKey(businessDateKey(startedAt, timeZone)).getTime();
  const to = dateOnlyFromKey(businessDateKey(now, timeZone)).getTime();

  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * The timeline line of a delivery a route closed with pending stops handed
 * back (K11): why it is Pendente again, in the dispatcher's own words —
 * the same kind of line a cancellation writes (K8).
 */
function routeClosedWithPendingNote(route: {
  code: number;
  closure_reason?: string | null;
}): string {
  const reason = route.closure_reason?.trim();

  return reason
    ? `Rota ${route.code} encerrada com pendências: ${reason}`
    : `Rota ${route.code} encerrada com pendências.`;
}

export {
  ROUTE_LEFT_OPEN_HOURS,
  inheritedFromRunningRoutes,
  inheritedOpenStops,
  isRouteLeftOpen,
  leftOpenDays,
  leftOpenStartedBefore,
  routeClosedWithPendingNote,
};
export type { InheritedOpenStops };
