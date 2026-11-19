/**
 * dashboard_rollup in /health/metrics (plano-escala F4-22, decision D52):
 * what the shadow of DASHBOARD_ROLLUP_MODE found on this replica since it
 * started, and how often "on" had to count live because its rollup read
 * failed.
 *
 * Per replica and since it started, like the legacy-contract counters. The
 * durable record is the log: every divergence is a warn line,
 * "dashboard rollup diverged from the live count", with the window and both
 * answers. The owner's gate before DASHBOARD_ROLLUP_MODE=on is seven days
 * of shadow with no such line and windows_diverged at 0 on every replica.
 */

/**
 * How one window ended:
 *  - agreed: the rollup gave what the screen served;
 *  - raced: it did not, but the rollup and a live count read in ONE
 *    statement agreed: a delivery was created or removed between the
 *    screen's read and the comparison;
 *  - diverged: they disagreed inside one snapshot: a stored day is wrong.
 */
type RollupWindowOutcome = "agreed" | "raced" | "diverged";

const counts = {
  windows_compared: 0,
  windows_agreed: 0,
  windows_raced: 0,
  windows_diverged: 0,
  views_skipped: 0,
  failures: 0,
  on_fallbacks: 0,
};

let lastDivergenceAt: Date | null = null;

function countRollupWindow(outcome: RollupWindowOutcome): void {
  counts.windows_compared += 1;

  if (outcome === "agreed") counts.windows_agreed += 1;
  if (outcome === "raced") counts.windows_raced += 1;

  if (outcome === "diverged") {
    counts.windows_diverged += 1;
    lastDivergenceAt = new Date();
  }
}

/** A view not compared: another comparison of this replica was running. */
function countRollupSkip(): void {
  counts.views_skipped += 1;
}

/** A comparison that failed (a statement error): nothing was concluded. */
function countRollupFailure(): void {
  counts.failures += 1;
}

/** With "on", a read of the rollup that failed and was counted live. */
function countRollupFallback(): void {
  counts.on_fallbacks += 1;
}

/** A snapshot, for /health/metrics. */
function dashboardRollupMetrics(): typeof counts & {
  last_divergence_at: string | null;
} {
  return {
    ...counts,
    last_divergence_at: lastDivergenceAt?.toISOString() ?? null,
  };
}

/** For tests: back to a replica that just started. */
function resetDashboardRollupMetrics(): void {
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    counts[key] = 0;
  }

  lastDivergenceAt = null;
}

export {
  countRollupFailure,
  countRollupFallback,
  countRollupSkip,
  countRollupWindow,
  dashboardRollupMetrics,
  resetDashboardRollupMetrics,
};
export type { RollupWindowOutcome };
