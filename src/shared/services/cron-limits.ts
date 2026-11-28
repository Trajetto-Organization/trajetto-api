/**
 * The cron's fixed limits, apart from the scheduler so the env schema can
 * check a setting against them without importing the database.
 */

/**
 * Ceiling on a single run. An expired lease means the replica stopped or lost
 * the database mid-run: the catch-up sweep marks that row FAILED and, if the
 * job has no success in its window, runs it again.
 */
const EXECUTION_LEASE_MS = 10 * 60 * 1000;

/**
 * A purge stops at half the lease at most (CRON_PURGE_RUN_BUDGET_MS), so a
 * live run is never mistaken for a dead one and never runs beside its own
 * re-run. The boot refuses a budget above this.
 */
const MAX_PURGE_RUN_BUDGET_MS = EXECUTION_LEASE_MS / 2;

const DEFAULT_PURGE_RUN_BUDGET_MS = MAX_PURGE_RUN_BUDGET_MS;

/**
 * When a partial run is retried by the catch-up sweep (F1-17): after the
 * nightly backups (05:00 UTC) and before the morning traffic, never in the
 * middle of the day.
 */
const DEFAULT_PARTIAL_RETRY_WINDOW_UTC = "06:00-09:00";

const DEFAULT_PARTIAL_RETRIES_PER_DAY = 3;

interface UtcWindow {
  /** Minutes after 00:00 UTC, inclusive. */
  startMinute: number;

  /** Minutes after 00:00 UTC, exclusive; 24:00 is 1440. */
  endMinute: number;
}

/**
 * "HH:MM-HH:MM" in UTC, start before end on the same day (24:00 allowed as
 * an end). Anything else is null: the env schema refuses it at boot.
 */
function parseUtcWindow(text: string): UtcWindow | null {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(text.trim());

  if (!match) return null;

  const [startHour, startMin, endHour, endMin] = match.slice(1).map(Number);

  if (startHour > 23 || startMin > 59 || endMin > 59) return null;
  if (endHour > 24 || (endHour === 24 && endMin > 0)) return null;

  const startMinute = startHour * 60 + startMin;
  const endMinute = endHour * 60 + endMin;

  return startMinute < endMinute ? { startMinute, endMinute } : null;
}

export {
  DEFAULT_PARTIAL_RETRIES_PER_DAY,
  DEFAULT_PARTIAL_RETRY_WINDOW_UTC,
  DEFAULT_PURGE_RUN_BUDGET_MS,
  EXECUTION_LEASE_MS,
  MAX_PURGE_RUN_BUDGET_MS,
  parseUtcWindow,
};
export type { UtcWindow };
