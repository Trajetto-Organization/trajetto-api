import { sqlStateOf } from "@/shared/errors/prisma-error-meta";
import { logger } from "@/shared/logging/logger";

import type {
  ITenantDayRollupRepository,
  RollupCoverageRow,
  RollupGroup,
  RollupKeep,
  RollupUnit,
} from "./tenant-day-rollup-repository";
import {
  dayBounds,
  deliveryMetric,
  planMetric,
  rollupZones,
  zoneCalendar,
  type MetricCoverage,
  type ZoneCalendar,
} from "./tenant-day-rules";

/**
 * One run of the dashboard's rollup (plano-escala F4-21, decision D52):
 * every company's closed days of deliveries counted into tenant_day_count,
 * in its zone and in the platform's, so the overview and the trends
 * (F4-22) add days up instead of counting months on every view.
 *
 * The order of a run, and why:
 *
 *  1. The marks (tenant_day_dirty, F4-20) become the company's pending
 *     days, in one transaction. The trigger skips a day already marked, so
 *     a writer that changed a delivery while the mark was there left no
 *     mark of its own; once the mark is gone, the next writer marks again.
 *  2. Before counting, the run waits until every transaction in flight
 *     when the marks went has ended: a writer that skipped the old mark
 *     may commit after a count taken too soon, and nothing would mark its
 *     change again. A pending day is settled only by a count taken after
 *     that wait, in the same statement that stores it. Without the wait
 *     (it timed out) the pending days stay for the next run; a run that dies
 *     anywhere leaves them too.
 *  3. Each company's days due now (plan in tenant-day-rules.ts): the days
 *     after its last stored one, D−8 to D−1 when it has deliveries there,
 *     and its pending days; then what it keeps no longer is pruned.
 *  4. The history is filled backwards, a quarter per metric and round, while
 *     the budget lasts.
 *
 * Every write is bounded by the run's deadline (CRON_PURGE_RUN_BUDGET_MS),
 * checked between statements; whatever is left makes the run partial, and
 * the next run, 15 minutes later, takes it from there.
 */

const log = logger.child({ component: "rollup" });

/** Marks taken per run: a reversal of a whole year of imports, at most. */
const MARKS_PER_RUN = 20_000;

/** Pending days settled per company and run. */
const PENDING_PER_BUSINESS = 1_000;

/**
 * Days per statement. Each is a range count over delivery's
 * (businessId, created_at) index; 400 days of the platform's busiest
 * company are a few seconds, so the deadline is never overrun by much.
 */
const UNITS_PER_STATEMENT = 400;

/** How long a run waits for the transactions in flight, at most. */
const SETTLE_WAIT_MS = 60_000;
const SETTLE_POLL_MS = 250;

/**
 * A statement that lost to something passing, not a broken run: the
 * company was deleted under it (23503), a lock it needed was held past
 * lock_timeout (55P03), a deadlock or a serialization failure. The phase
 * stops there and the next run counts again.
 */
const TRANSIENT_STATES = new Set(["23503", "55P03", "40P01", "40001"]);

/** The parts of a run that can be left with work: names, never data. */
type RollupPart = "marks" | "pending" | "settle" | "recount" | "backfill";

interface TenantDayRollupReport {
  businesses: number;
  marksTaken: number;
  pendingSettled: number;
  recounted: number;
  backfilled: number;
  pruned: number;
  left: RollupPart[];
}

interface TenantDayRollupOptions {
  repo: ITenantDayRollupRepository;
  now?: Date;
  /** When the run stops starting statements (an epoch in ms). */
  deadline?: number;
  settleWaitMs?: number;
  pollMs?: number;
  marksPerRun?: number;
  unitsPerStatement?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

interface Subject {
  businessId: string;
  zones: string[];
}

function coverageKey(businessId: string, metric: string): string {
  return `${businessId}\u0000${metric}`;
}

function indexCoverage(
  rows: readonly RollupCoverageRow[],
): Map<string, MetricCoverage> {
  return new Map(
    rows.map((row) => [
      coverageKey(row.businessId, row.metric),
      row.first !== null && row.last !== null
        ? { first: row.first, last: row.last }
        : null,
    ]),
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Groups packed into statements of up to `max` days, a company's days never
 * split: its stored days must stay without a hole if a later statement of
 * the run fails.
 */
function pack(groups: readonly RollupGroup[], max: number): RollupGroup[][] {
  const chunks: RollupGroup[][] = [];
  let chunk: RollupGroup[] = [];
  let size = 0;

  for (const group of groups) {
    const weight = Math.max(1, group.units.length);

    if (chunk.length > 0 && size + weight > max) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }

    chunk.push(group);
    size += weight;
  }

  if (chunk.length > 0) chunks.push(chunk);

  return chunks;
}

/** Stores chunk after chunk until the deadline or a statement that lost. */
async function storeChunks(
  repo: ITenantDayRollupRepository,
  groups: readonly RollupGroup[],
  {
    max,
    deadline,
    clock,
  }: { max: number; deadline: number; clock: () => number },
): Promise<{ stored: number; settled: number; stopped: boolean }> {
  let stored = 0;
  let settled = 0;

  for (const chunk of pack(groups, max)) {
    if (clock() >= deadline) return { stored, settled, stopped: true };

    try {
      const result = await repo.store(chunk);

      stored += result.stored;
      settled += result.settled;
    } catch (error) {
      const state = sqlStateOf(error);

      if (!state || !TRANSIENT_STATES.has(state)) throw error;

      log.warn(
        { sqlState: state, businesses: chunk.length },
        "rollup statement lost to a concurrent change; the next run counts again",
      );

      return { stored, settled, stopped: true };
    }
  }

  return { stored, settled, stopped: false };
}

/** Waits for every transaction in flight now to end, up to `until`. */
async function waitForInFlight(
  repo: ITenantDayRollupRepository,
  {
    until,
    pollMs,
    sleep,
    clock,
  }: {
    until: number;
    pollMs: number;
    sleep: (ms: number) => Promise<void>;
    clock: () => number;
  },
): Promise<boolean> {
  const horizon = await repo.inFlightHorizon();

  for (;;) {
    if (await repo.settledSince(horizon)) return true;
    if (clock() >= until) return false;

    await sleep(pollMs);
  }
}

function unitsOf(
  days: readonly string[],
  metric: string,
  timeZone: string,
): RollupUnit[] {
  return days.map((day) => ({ metric, day, ...dayBounds(day, timeZone) }));
}

async function rollUpTenantDays({
  repo,
  now = new Date(),
  deadline = Number.POSITIVE_INFINITY,
  settleWaitMs = SETTLE_WAIT_MS,
  pollMs = SETTLE_POLL_MS,
  marksPerRun = MARKS_PER_RUN,
  unitsPerStatement = UNITS_PER_STATEMENT,
  sleep = defaultSleep,
  clock = Date.now,
}: TenantDayRollupOptions): Promise<TenantDayRollupReport> {
  const left = new Set<RollupPart>();
  const report: TenantDayRollupReport = {
    businesses: 0,
    marksTaken: 0,
    pendingSettled: 0,
    recounted: 0,
    backfilled: 0,
    pruned: 0,
    left: [],
  };

  const calendars = new Map<string, ZoneCalendar>();
  const calendarOf = (timeZone: string): ZoneCalendar => {
    let calendar = calendars.get(timeZone);

    if (!calendar) {
      calendar = zoneCalendar(now, timeZone);
      calendars.set(timeZone, calendar);
    }

    return calendar;
  };

  const businesses = await repo.listBusinesses();
  const subjects: Subject[] = businesses.map((business) => ({
    businessId: business.id,
    zones: rollupZones(business.timezone),
  }));

  report.businesses = subjects.length;

  // 1. The marks become pending days.
  const taken = await repo.takeDirtyMarks(marksPerRun);

  report.marksTaken = taken.taken;
  if (taken.taken >= marksPerRun) left.add("marks");

  const pending = new Map<string, string[]>();

  for (const row of await repo.listPending(
    subjects.map((subject) => subject.businessId),
    PENDING_PER_BUSINESS + 1,
  )) {
    const days = pending.get(row.businessId) ?? [];

    if (days.length < PENDING_PER_BUSINESS) days.push(row.day);
    else left.add("pending");

    pending.set(row.businessId, days);
  }

  // 2. No count before the writers that skipped a taken mark are done.
  if (pending.size > 0) {
    const settled = await waitForInFlight(repo, {
      until: Math.min(clock() + settleWaitMs, deadline),
      pollMs,
      sleep,
      clock,
    });

    if (!settled) {
      left.add("settle");
      pending.clear();
    }
  }

  // 3. The days due now.
  const keys = subjects.flatMap((subject) =>
    subject.zones.map((zone) => ({
      businessId: subject.businessId,
      metric: deliveryMetric(zone),
    })),
  );
  const coverage = indexCoverage(await repo.coverage(keys));

  const active = new Set(
    await repo.activeBusinesses(
      subjects.map((subject) => {
        const bounds = subject.zones.map((zone) => {
          const calendar = calendarOf(zone);

          return {
            from: dayBounds(calendar.recounted[0], zone).from,
            to: dayBounds(calendar.yesterday, zone).to,
          };
        });

        return {
          businessId: subject.businessId,
          from: new Date(Math.min(...bounds.map((b) => b.from.getTime()))),
          to: new Date(Math.max(...bounds.map((b) => b.to.getTime()))),
        };
      }),
    ),
  );

  const groups: RollupGroup[] = [];
  const pruned: string[] = [];
  const keep: RollupKeep[] = [];
  const backfilling = new Set<string>();

  for (const subject of subjects) {
    const units: RollupUnit[] = [];
    let prune = false;

    for (const zone of subject.zones) {
      const calendar = calendarOf(zone);
      const metric = deliveryMetric(zone);
      const stored =
        coverage.get(coverageKey(subject.businessId, metric)) ?? null;
      const plan = planMetric({
        calendar,
        coverage: stored,
        active: active.has(subject.businessId),
        pendingUtcDays: pending.get(subject.businessId) ?? [],
      });

      units.push(...unitsOf(plan.recount, metric, zone));
      keep.push({
        businessId: subject.businessId,
        metric,
        from: calendar.historyStart,
      });

      // A metric with no row yet may be a zone the company just left
      // another for: that zone's rows go with the prune.
      if (plan.prune || stored === null) prune = true;
      if (stored === null || plan.backfill.length > 0) {
        backfilling.add(subject.businessId);
      }
    }

    const settle = pending.get(subject.businessId) ?? [];

    if (units.length > 0 || settle.length > 0) {
      groups.push({ businessId: subject.businessId, units, settle });
    }

    if (prune) pruned.push(subject.businessId);
  }

  const recount = await storeChunks(repo, groups, {
    max: unitsPerStatement,
    deadline,
    clock,
  });

  report.recounted = recount.stored;
  report.pendingSettled = recount.settled;
  if (recount.stopped) left.add("recount");

  if (pruned.length > 0) {
    const companies = new Set(pruned);

    report.pruned = await repo.prune(
      pruned,
      keep.filter((entry) => companies.has(entry.businessId)),
    );
  }

  // 4. The history, backwards, while the budget lasts.
  let candidates = subjects.filter((subject) =>
    backfilling.has(subject.businessId),
  );

  while (candidates.length > 0 && !left.has("recount")) {
    if (clock() >= deadline) {
      left.add("backfill");
      break;
    }

    const covered = indexCoverage(
      await repo.coverage(
        candidates.flatMap((subject) =>
          subject.zones.map((zone) => ({
            businessId: subject.businessId,
            metric: deliveryMetric(zone),
          })),
        ),
      ),
    );

    const round: RollupGroup[] = [];

    for (const subject of candidates) {
      const units = subject.zones.flatMap((zone) => {
        const metric = deliveryMetric(zone);
        const plan = planMetric({
          calendar: calendarOf(zone),
          coverage:
            covered.get(coverageKey(subject.businessId, metric)) ?? null,
          active: false,
          pendingUtcDays: [],
        });

        return unitsOf(plan.backfill, metric, zone);
      });

      if (units.length > 0) {
        round.push({ businessId: subject.businessId, units, settle: [] });
      }
    }

    if (round.length === 0) break;

    const filled = await storeChunks(repo, round, {
      max: unitsPerStatement,
      deadline,
      clock,
    });

    report.backfilled += filled.stored;

    if (filled.stopped) {
      left.add("backfill");
      break;
    }

    // Nothing stored: what is left belongs to companies the store skips
    // (being purged since the run began), which no round would fill.
    if (filled.stored === 0) break;

    const next = new Set(round.map((group) => group.businessId));

    candidates = candidates.filter((subject) => next.has(subject.businessId));
  }

  report.left = [...left];

  return report;
}

export {
  MARKS_PER_RUN,
  PENDING_PER_BUSINESS,
  SETTLE_WAIT_MS,
  UNITS_PER_STATEMENT,
  rollUpTenantDays,
};
export type { RollupPart, TenantDayRollupOptions, TenantDayRollupReport };
