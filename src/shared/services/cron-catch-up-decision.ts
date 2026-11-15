import { isPartialRunMessage } from "@/shared/errors/partial-run-error";
import type { UtcWindow } from "@/shared/services/cron-limits";

/**
 * Whether the hourly catch-up sweep runs a daily job now (GAP6-9, and the
 * partial runs of plano-escala F1-17). Pure: the scheduler reads the facts,
 * this decides.
 *
 * Two different misses:
 *
 *  - a job with no success in its window (a firing lost to a database
 *    outage, a replica that died mid-run, a run that failed): run it now,
 *    at most once an hour, whatever the hour — as before;
 *  - a job whose LAST run was partial (a purge that stopped on its budget
 *    or ceiling with rows still due): run it again only inside the partial
 *    window (CRON_PARTIAL_RETRY_WINDOW_UTC, after the 05:00 UTC backups and
 *    before the morning) and at most CRON_PARTIAL_RETRIES_PER_DAY times
 *    that day. Without this, a purge that never finishes would be re-run
 *    every hour through business hours, against the traffic. What is left
 *    waits for the next night; 26 h of nothing but partials pages.
 *
 * A partial takes precedence over an older success: work is still due even
 * though the job succeeded yesterday.
 */
interface PartialRetryPolicy {
  window: UtcWindow;
  retriesPerDay: number;
}

interface CatchUpFacts {
  now: Date;

  /** The job's newest row (by scheduledFor); null when it has none. */
  lastRun: {
    status: "RUNNING" | "SUCCEEDED" | "FAILED";
    lastError: string | null;
  } | null;

  /** A RUNNING row whose lease is still live. */
  running: boolean;

  /** A SUCCEEDED run inside the job's catch-up window. */
  succeededInWindow: boolean;

  /** This job's runs already inside today's partial window. */
  partialRetriesToday: number;
}

type CatchUpDecision =
  | { run: true; reason: "missed" | "partial" }
  | {
      run: false;
      reason:
        | "running"
        | "covered"
        | "partial_outside_window"
        | "partial_retries_exhausted";
    };

function minuteOfDayUtc(at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

/** Today's partial window (UTC) around `now`, as instants. */
function partialWindowOn(
  now: Date,
  window: UtcWindow,
): { start: Date; end: Date } {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  return {
    start: new Date(midnight + window.startMinute * 60_000),
    end: new Date(midnight + window.endMinute * 60_000),
  };
}

function inPartialWindow(now: Date, window: UtcWindow): boolean {
  const minute = minuteOfDayUtc(now);

  return minute >= window.startMinute && minute < window.endMinute;
}

function catchUpDecision(
  facts: CatchUpFacts,
  policy: PartialRetryPolicy,
): CatchUpDecision {
  if (facts.running) return { run: false, reason: "running" };

  const lastWasPartial =
    facts.lastRun?.status === "FAILED" &&
    isPartialRunMessage(facts.lastRun.lastError);

  if (lastWasPartial) {
    if (!inPartialWindow(facts.now, policy.window)) {
      return { run: false, reason: "partial_outside_window" };
    }

    if (facts.partialRetriesToday >= policy.retriesPerDay) {
      return { run: false, reason: "partial_retries_exhausted" };
    }

    return { run: true, reason: "partial" };
  }

  if (facts.succeededInWindow) return { run: false, reason: "covered" };

  return { run: true, reason: "missed" };
}

export { catchUpDecision, inPartialWindow, partialWindowOn };
export type { CatchUpDecision, CatchUpFacts, PartialRetryPolicy };
