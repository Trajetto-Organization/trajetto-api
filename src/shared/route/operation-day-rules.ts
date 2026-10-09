/**
 * The pieces of "the operation of the day" that are judgements rather than
 * queries (decision 7.1), shared by the Prisma repository's SQL and its
 * in-memory twin so the two cannot drift.
 */

import {
  businessDateKey,
  businessDayRange,
  dateOnlyFromKey,
  resolveTimeZone,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

import type {
  FeedEntry,
  OperationDay,
} from "@/modules/route/repositories/IOperation-day-repository";

/**
 * How far back an ended route or a route event is looked for.
 *
 * Every such read goes through `route (businessId, status, scheduled_date)`,
 * and a timestamp like `completed_at` has no index: bounding the scheduled
 * day keeps them proportional to a week of routes instead of to the tenant's
 * whole history. A route that runs for more than a week is not something this
 * product plans.
 */
const ROUTE_LOOKBACK_DAYS = 7;

/**
 * When a fact happened, never later than when the server stored it.
 *
 * The app sends its own clock (offline facts arrive hours late), so the
 * device time is what places the fact in a day. A phone whose clock runs
 * ahead cannot push a fact past the moment it reached us — the SQL spells
 * this `LEAST(COALESCE(occurred_at, created_at), created_at)`.
 */
function factInstant(occurredAt: Date | null, createdAt: Date): Date {
  if (!occurredAt || occurredAt.getTime() > createdAt.getTime()) return createdAt;

  return occurredAt;
}

/**
 * When a FAILED delivery failed: the latest failure fact, or `updated_at`
 * for an old row with none.
 *
 * Not `updated_at` alone: FAILED deliveries stay editable, and editing an old
 * failure counted it again as "insucesso de hoje" (DLV-MON-2).
 */
function failureInstant(updatedAt: Date, facts: ReadonlyArray<Date | null>): Date {
  const known = facts.filter((fact): fact is Date => fact !== null);

  if (known.length === 0) return updatedAt;

  return new Date(Math.max(...known.map((fact) => fact.getTime())));
}

/**
 * The authorisations under which a blocking occurrence is a failure. PENDING
 * still waits for a manager (decision 6.3); DENIED and SUPERSEDED never
 * failed anything. The SQL spells the same list as literals.
 */
const FAILURE_AUTHORIZATIONS: readonly string[] = ["NOT_REQUIRED", "APPROVED"];

/**
 * Whether an occurrence is an insucesso: a blocking type, and not waiting for
 * (or refused by) a manager. One rule for the failure fact and for the feed's
 * red line, whichever table the occurrence is read through.
 */
function isFailureOccurrence(
  blocksDelivery: boolean | null | undefined,
  authorizationStatus: string | null | undefined,
): boolean {
  return Boolean(blocksDelivery) && FAILURE_AUTHORIZATIONS.includes(authorizationStatus ?? "");
}

/**
 * When a stop settled: `LEAST(completed_at, updated_at)`, which skips a NULL
 * the way Postgres does. A later edit of the row never moves the outcome.
 */
function stopSettledAt(completedAt: Date | null, updatedAt: Date): Date {
  return completedAt && completedAt.getTime() < updatedAt.getTime() ? completedAt : updatedAt;
}

function isWithinDay(instant: Date | null | undefined, day: OperationDay): boolean {
  if (!instant) return false;

  const time = instant.getTime();

  return time >= day.start.getTime() && time < day.end.getTime();
}

/**
 * The company's day as the repositories read it.
 *
 * `date` is a "YYYY-MM-DD" in the company's zone; without one, the day that
 * contains `now` there.
 */
function operationDay(
  timeZone: string | null | undefined,
  now: Date,
  date?: string,
): OperationDay {
  const zone = resolveTimeZone(timeZone);
  const today = businessDateKey(now, zone);

  if (!date || date === today) {
    return { date: today, ...businessDayRange(now, zone), isToday: true };
  }

  // Validates the key (2026-02-30 throws) and reads its parts.
  const civil = dateOnlyFromKey(date);

  const year = civil.getUTCFullYear();
  const month = civil.getUTCMonth() + 1;
  const day = civil.getUTCDate();

  return {
    date,
    start: zonedWallTimeToUtc(zone, year, month, day),
    end: zonedWallTimeToUtc(zone, year, month, day + 1),
    isToday: false,
  };
}

type RouteMoveKind = "ROUTE_STARTED" | "ROUTE_COMPLETED" | "ROUTE_CANCELLED";

const ROUTE_MOVES: Record<RouteMoveKind, { suffix: string; actor: string }> = {
  // Only the driver's app starts a route.
  ROUTE_STARTED: { suffix: "started", actor: "DRIVER_APP" },

  // Reached on its own when the last stop settles.
  ROUTE_COMPLETED: { suffix: "completed", actor: "SYSTEM" },

  ROUTE_CANCELLED: { suffix: "cancelled", actor: "USER" },
};

/**
 * A route that started, completed or was cancelled, as a feed line — the
 * same line from the SQL and from the twin. `at` is both when it happened
 * and when the server knew: the route's own columns are server time.
 */
function routeMoveEntry(move: {
  id: string;
  code: number;
  kind: RouteMoveKind;
  at: Date;
  driverName: string | null;
}): FeedEntry {
  const { suffix, actor } = ROUTE_MOVES[move.kind];

  return {
    id: `route:${move.id}:${suffix}`,
    source: "route",
    type: move.kind,
    actor,
    deliveryId: null,
    recipientName: null,
    routeId: move.id,
    routeCode: move.code,
    driverName: move.driverName,
    detail: null,
    failure: false,
    occurredAt: move.at,
    receivedAt: move.at,
  };
}

export {
  FAILURE_AUTHORIZATIONS,
  ROUTE_LOOKBACK_DAYS,
  factInstant,
  failureInstant,
  isFailureOccurrence,
  isWithinDay,
  operationDay,
  routeMoveEntry,
  stopSettledAt,
  type RouteMoveKind,
};
