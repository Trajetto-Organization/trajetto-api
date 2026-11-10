import { dateOnlyKey } from "@/shared/time/business-day";
import {
  listPeriodDays,
  type ListPeriodInput,
} from "@/shared/time/list-period";

import type { OperationDay } from "@/modules/route/repositories/IOperation-day-repository";
import type { RouteStatus } from "@/shared/route/route-rules";

/**
 * The period of the routes (plan of 09/11/2026): the Rotas list and the
 * Torre's board by route, Hoje / 7 / 14 / 30 dias / Personalizado.
 *
 * A route's period is its DAY — `scheduled_date`, the "Data" column the list
 * shows and the day the tower already reads (decision 1.3) — in the
 * company's zone, never its creation: Tuesday's route is planned on Monday,
 * and by creation it would leave Tuesday's "Hoje" before the first truck
 * did.
 *
 * And a route forgotten "Em andamento" (D26) never leaves the screen: when
 * the period reaches today, every route still running belongs to it, the
 * same rule the tower has always applied to its one day
 * (operation-day-repository: `scheduled_date = day OR (isToday AND
 * IN_PROGRESS)`), widened from one day to N. A manager who opens Rotas on
 * Hoje still sees the route left open on 30/10, with its "Aberta desde"
 * badge.
 *
 * The Rotas list keeps one more kind of unfinished route (routeListPeriodDays):
 * one of an earlier day that never left, still PLANNED or RELEASED, whose
 * deliveries wait on it. Before the period the list showed every date, and
 * such a route was there; on Hoje it would vanish with nothing to say it
 * exists. The tower's board does not take it: it opens exactly as it always
 * did, the day's routes and the running ones.
 *
 * One rule for the Prisma `where`, the tower's SQL and their in-memory
 * twins, so the four cannot drift.
 */
interface RoutePeriodDays {
  /** First civil day, "YYYY-MM-DD", included. */
  from: string;
  /** Last civil day, "YYYY-MM-DD", included. */
  to: string;
  /** The period contains the company's today: the running routes join it. */
  includesRunning: boolean;
}

/**
 * The statuses of a route that has not left yet: one of an earlier day in
 * either is overdue, the list's other unfinished route.
 */
const NOT_DEPARTED_STATUSES = [
  "PLANNED",
  "RELEASED",
] as const satisfies readonly RouteStatus[];

/** The Rotas list's period: the tower's, and the overdue routes with it. */
interface RouteListPeriodDays extends RoutePeriodDays {
  /**
   * The period contains the company's today: every route of a day before
   * `from` that never left (NOT_DEPARTED_STATUSES) joins it too. The days
   * from `from` on are already the period's own.
   */
  includesOverdue: boolean;
}

/** The days a validated period covers for routes, or null for every date. */
function routePeriodDays(
  input: ListPeriodInput,
  timeZone: string,
  now: Date = new Date(),
): RoutePeriodDays | null {
  const days = listPeriodDays(input, timeZone, now);

  if (!days) return null;

  return {
    from: days.from,
    to: days.to,
    includesRunning: days.from <= days.today && days.today <= days.to,
  };
}

/**
 * The days of the Rotas list's period: the overdue routes join whenever the
 * running ones do, a period that reaches the company's today.
 */
function routeListPeriodDays(
  input: ListPeriodInput,
  timeZone: string,
  now: Date = new Date(),
): RouteListPeriodDays | null {
  const days = routePeriodDays(input, timeZone, now);

  return days ? { ...days, includesOverdue: days.includesRunning } : null;
}

/** The tower's one day (`?day=`, or none) as a period of routes. */
function routeDaysOfOperationDay(day: OperationDay): RoutePeriodDays {
  return { from: day.date, to: day.date, includesRunning: day.isToday };
}

/**
 * Whether a route is in the period: its day in it, running into it, or, on
 * the list, overdue into it.
 */
function isRouteInPeriod(
  route: { scheduled_date: Date; status: string },
  days: RoutePeriodDays & { includesOverdue?: boolean },
): boolean {
  const day = dateOnlyKey(route.scheduled_date);

  return (
    (days.from <= day && day <= days.to) ||
    (days.includesRunning && route.status === "IN_PROGRESS") ||
    (Boolean(days.includesOverdue) &&
      day < days.from &&
      (NOT_DEPARTED_STATUSES as readonly string[]).includes(route.status))
  );
}

export {
  NOT_DEPARTED_STATUSES,
  isRouteInPeriod,
  routeDaysOfOperationDay,
  routeListPeriodDays,
  routePeriodDays,
  type RouteListPeriodDays,
  type RoutePeriodDays,
};
