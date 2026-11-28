/**
 * The hourly delta of pg_stat_statements (plano-escala F1-12), pure.
 *
 * The view is cumulative: each counter grows from the last reset of the
 * statistics, or from when the statement entered the view. The hourly
 * snapshot keeps every statement's counters as the baseline and, an hour
 * later, writes the difference for the statements that cost the most in
 * that hour. Three things make a plain subtraction wrong, and this is where
 * they are handled:
 *
 *  - a reset (pg_stat_statements_info.stats_reset moved since the
 *    baseline): every counter started over after the baseline, so the
 *    view's numbers ARE the delta, and subtracting would go negative;
 *  - an eviction: at pg_stat_statements.max the view throws the least used
 *    entries away (pg_stat_statements_info.dealloc counts them) and a
 *    statement that runs again re-enters from zero. PG16 has no per-entry
 *    start time, so a re-entry is seen as a counter below its baseline:
 *    its counters are then the delta. A re-entry that already grew past its
 *    old counters cannot be told apart and is undercounted, which a rising
 *    dealloc warns about;
 *  - the maximum: PG16 keeps one max_exec_time per entry, since the entry
 *    began. There is no maximum of the hour to compute, so the row carries
 *    the cumulative one, as the view does.
 *
 * Statements are told apart by (userid, toplevel, queryid) inside one
 * database: the same text run by two roles, or nested in a function, is a
 * different entry with its own counters.
 */

/** One entry of the view, its counters cumulative. */
interface StatementCounters {
  /** The role's oid, as text. */
  userid: string;
  toplevel: boolean;

  /** Signed 64-bit: as text, because a JS number would round it. */
  queryid: string;

  calls: number;

  /** Milliseconds. */
  total_exec_time: number;
  total_plan_time: number;
  max_exec_time: number;

  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  shared_blks_dirtied: number;
  shared_blks_written: number;
  temp_blks_written: number;
  wal_bytes: number;
}

/** The counters that only grow between resets; max_exec_time is not one. */
const CUMULATIVE = [
  "calls",
  "total_exec_time",
  "total_plan_time",
  "rows",
  "shared_blks_hit",
  "shared_blks_read",
  "shared_blks_dirtied",
  "shared_blks_written",
  "temp_blks_written",
  "wal_bytes",
] as const;

type CumulativeCounter = (typeof CUMULATIVE)[number];

/** What the baseline keeps of each entry: the cumulative counters. */
type BaselineCounters = Pick<
  StatementCounters,
  "userid" | "toplevel" | "queryid" | CumulativeCounter
>;

/**
 * How a row's delta was taken: against the baseline ("previous"), or the
 * view's own counters because the entry is new in the hour ("new"), came
 * back after an eviction ("recreated"), or the statistics were reset
 * ("reset").
 */
type DeltaBasis = "previous" | "new" | "recreated" | "reset";

interface StatementDelta extends StatementCounters {
  basis: DeltaBasis;
}

interface DiffResult {
  /** The top N by execution time in the period, most expensive first. */
  top: StatementDelta[];

  /** Statements that ran in the period. */
  active: number;

  /** Entries that came back after an eviction. */
  recreated: number;

  /**
   * Baseline entries the view no longer has (evicted, or reset away): what
   * they cost since the baseline is lost.
   */
  vanished: number;
}

function keyOf(entry: BaselineCounters): string {
  return `${entry.userid}:${entry.toplevel ? "t" : "f"}:${entry.queryid}`;
}

function deltaOf(
  current: StatementCounters,
  previous: BaselineCounters | undefined,
  reset: boolean,
): StatementDelta {
  const wentBackwards =
    previous !== undefined &&
    CUMULATIVE.some((counter) => current[counter] < previous[counter]);

  const basis: DeltaBasis = reset
    ? "reset"
    : previous === undefined
      ? "new"
      : wentBackwards
        ? "recreated"
        : "previous";

  if (basis !== "previous" || previous === undefined) {
    return { ...current, basis };
  }

  const delta: StatementDelta = { ...current, basis };

  for (const counter of CUMULATIVE) {
    delta[counter] = current[counter] - previous[counter];
  }

  return delta;
}

/** Most expensive first; ties by calls, then by key, so a run is repeatable. */
function byCost(a: StatementDelta, b: StatementDelta): number {
  return (
    b.total_exec_time - a.total_exec_time ||
    b.calls - a.calls ||
    keyOf(a).localeCompare(keyOf(b))
  );
}

function diffStatements({
  current,
  baseline,
  reset,
  top,
}: {
  current: StatementCounters[];
  baseline: BaselineCounters[];

  /** stats_reset moved since the baseline was taken. */
  reset: boolean;
  top: number;
}): DiffResult {
  const previous = new Map(baseline.map((entry) => [keyOf(entry), entry]));
  const seen = new Set<string>();
  const deltas: StatementDelta[] = [];

  for (const entry of current) {
    const key = keyOf(entry);

    seen.add(key);

    const delta = deltaOf(entry, previous.get(key), reset);

    if (delta.calls > 0) deltas.push(delta);
  }

  deltas.sort(byCost);

  let vanished = 0;

  for (const key of previous.keys()) {
    if (!seen.has(key)) vanished += 1;
  }

  return {
    top: deltas.slice(0, Math.max(0, top)),
    active: deltas.length,
    recreated: deltas.filter((delta) => delta.basis === "recreated").length,
    vanished,
  };
}

export { CUMULATIVE, diffStatements };
export type {
  BaselineCounters,
  DeltaBasis,
  DiffResult,
  StatementCounters,
  StatementDelta,
};
