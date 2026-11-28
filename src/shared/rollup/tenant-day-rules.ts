import {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateKey,
  businessDayStart,
  businessMonthKey,
  resolveTimeZone,
  shiftDateKey,
  shiftMonthKey,
} from "@/shared/time/business-day";

/**
 * The rules of the dashboard's closed days (plano-escala F4-21, decision
 * D52): which days of which company the rollup job counts on a run, in
 * which zones, and when a stored day is due again. Pure: the job
 * (tenant-day-rollup.ts) reads the database and asks these.
 *
 * What is counted: a company's deliveries by the civil day of their
 * created_at, the dashboard's "Entregas" series (dashboard-repository.ts,
 * countArm). Only deliveries: they are the dashboard's heaviest count by
 * two orders of magnitude, and the only table whose changes to a past day
 * are marked (the triggers of F4-20 on delivery). Routes and the
 * catalogues stay counted live.
 *
 * A stored row is exact for its day, and every day between a metric's
 * first and last row has a row, zeros included: a reader (F4-22) that finds
 * as many rows as days in its window can trust them, and counts live what
 * is not there.
 */

/** A company's deliveries per civil day in one zone: `delivery@<IANA zone>`. */
const DELIVERY_METRIC_PREFIX = "delivery@";

/**
 * A dirty UTC day the job took from tenant_day_dirty and has not counted
 * yet (value 0). It lives in tenant_day_count, under the company's key,
 * so a run that dies between taking the marks and counting their days
 * leaves them for the next run instead of losing them: the marks are
 * already gone, and the trigger skips nothing for them any more.
 */
const PENDING_DELIVERY_METRIC = "pending:delivery";

/**
 * Closed days recounted on every run for a company with deliveries in
 * them: D−1 to D−8. A transaction that inserted a delivery before
 * midnight and committed after the day was counted is caught here (the
 * marks only see deletes and status changes), and so is anything the marks
 * could miss: the plan's mitigation of a rollup that drifts.
 */
const RECOUNTED_CLOSED_DAYS = 8;

/**
 * Months kept before the current one: the trends' longest window, "12m",
 * is the current month and the twelve before it
 * (get-dashboard-trends-usecase.ts, windowFor). Older rows are never read
 * and are pruned.
 */
const HISTORY_MONTHS = 12;

/**
 * Days filled backwards per metric and round: a quarter. The history of a
 * company new to the rollup (or to a zone) is filled in rounds, so one
 * company with years of deliveries cannot hold the whole run.
 */
const BACKFILL_DAYS_PER_ROUND = 92;

function deliveryMetric(timeZone: string): string {
  return `${DELIVERY_METRIC_PREFIX}${timeZone}`;
}

/**
 * The zones a company is counted in, once each: its own (`Business.timezone`,
 * the default for a missing or unknown one, as resolveTimeZone reads it
 * everywhere else) for its dashboard, and the platform's for the MASTER's,
 * which adds every company up on the platform's calendar.
 */
function rollupZones(storedZone: string | null | undefined): string[] {
  const own = resolveTimeZone(storedZone);

  return own === DEFAULT_BUSINESS_TIMEZONE
    ? [own]
    : [own, DEFAULT_BUSINESS_TIMEZONE];
}

/** Every day from `first` to `last`, both included, ascending. */
function daysBetween(first: string, last: string): string[] {
  const days: string[] = [];

  for (let day = first; day <= last; day = shiftDateKey(day, 1)) {
    days.push(day);
  }

  return days;
}

/**
 * [from, to) of a civil day in a zone: the zone's own midnights, the same
 * boundaries the dashboard files a row by (period-buckets.ts).
 */
function dayBounds(day: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: businessDayStart(day, timeZone),
    to: businessDayStart(shiftDateKey(day, 1), timeZone),
  };
}

/**
 * The civil days of a zone that a UTC day touches: a mark holds the UTC day
 * of the changed row's created_at (F4-20), and a row of that UTC day may
 * belong to either of two civil days (three, across a short DST day).
 */
function civilDaysOfUtcDay(utcDay: string, timeZone: string): string[] {
  const start = new Date(`${utcDay}T00:00:00.000Z`);
  const lastInstant = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  return daysBetween(
    businessDateKey(start, timeZone),
    businessDateKey(lastInstant, timeZone),
  );
}

/** A zone's calendar at `now`: today, the closed window and the history. */
interface ZoneCalendar {
  timeZone: string;
  today: string;
  /** D−1, the newest closed day. */
  yesterday: string;
  /** D−8 to D−1, ascending. */
  recounted: string[];
  /** The first day kept: the 1st of the month twelve months back. */
  historyStart: string;
}

function zoneCalendar(now: Date, timeZone: string): ZoneCalendar {
  const today = businessDateKey(now, timeZone);
  const yesterday = shiftDateKey(today, -1);

  return {
    timeZone,
    today,
    yesterday,
    recounted: daysBetween(
      shiftDateKey(today, -RECOUNTED_CLOSED_DAYS),
      yesterday,
    ),
    historyStart: `${shiftMonthKey(businessMonthKey(now, timeZone), -HISTORY_MONTHS)}-01`,
  };
}

/** The first and last stored day of a metric; null when it has none. */
type MetricCoverage = { first: string; last: string } | null;

interface MetricPlan {
  /** The days to count now, ascending. */
  recount: string[];
  /** The days to fill backwards in this round, ascending, ending at first−1. */
  backfill: string[];
  /** Whether rows of this company fall outside what it keeps. */
  prune: boolean;
}

/**
 * What one run does with one metric of one company.
 *
 *  - No row yet (a new company, a zone it just moved to), or only rows
 *    from before the history (the job was off for over a year): count the
 *    recounted window, D−8 to D−1, and fill the history backwards in the
 *    rounds after. Its old rows, if any, are pruned.
 *  - Rows that stop before yesterday: count every day after the last one,
 *    so the stored days never have a hole (a job that was off for two weeks
 *    counts the two weeks).
 *  - A company with deliveries created in the window: count D−8 to D−1.
 *  - The days its pending marks touch, closed and already stored. A day
 *    not closed yet is counted when it closes; one before the first row is
 *    counted by the backfill; one before the history is not kept.
 */
function planMetric({
  calendar,
  coverage,
  active,
  pendingUtcDays,
}: {
  calendar: ZoneCalendar;
  coverage: MetricCoverage;
  active: boolean;
  pendingUtcDays: readonly string[];
}): MetricPlan {
  const { yesterday, recounted, historyStart, timeZone } = calendar;

  const stale =
    coverage !== null && coverage.last < shiftDateKey(historyStart, -1);

  if (coverage === null || stale) {
    return { recount: [...recounted], backfill: [], prune: stale };
  }

  const days = new Set<string>();

  if (coverage.last < yesterday) {
    for (const day of daysBetween(shiftDateKey(coverage.last, 1), yesterday)) {
      days.add(day);
    }
  }

  if (active) {
    for (const day of recounted) {
      if (day >= coverage.first) days.add(day);
    }
  }

  for (const utcDay of pendingUtcDays) {
    for (const day of civilDaysOfUtcDay(utcDay, timeZone)) {
      if (day >= coverage.first && day >= historyStart && day <= yesterday) {
        days.add(day);
      }
    }
  }

  let backfill: string[] = [];

  if (coverage.first > historyStart) {
    const quarterBack = shiftDateKey(coverage.first, -BACKFILL_DAYS_PER_ROUND);

    backfill = daysBetween(
      quarterBack > historyStart ? quarterBack : historyStart,
      shiftDateKey(coverage.first, -1),
    );
  }

  return {
    recount: [...days].sort(),
    backfill,
    prune: coverage.first < historyStart,
  };
}

export {
  BACKFILL_DAYS_PER_ROUND,
  DELIVERY_METRIC_PREFIX,
  HISTORY_MONTHS,
  PENDING_DELIVERY_METRIC,
  RECOUNTED_CLOSED_DAYS,
  civilDaysOfUtcDay,
  dayBounds,
  daysBetween,
  deliveryMetric,
  planMetric,
  rollupZones,
  zoneCalendar,
};
export type { MetricCoverage, MetricPlan, ZoneCalendar };
