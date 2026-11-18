import { registerSampleSection } from "@/shared/health/ops-sample";

/**
 * The integration feed's conversions, counted per process and per minute
 * (plano-escala F2-05), into the `feed` section of the process's ops_sample
 * row.
 *
 * A conversion is never an error for the integrator, who gets the events
 * again and deduplicates them by id. But a cursor of another epoch means
 * the cluster's history changed under a live integration (a PITR, a
 * promote, a logical restore): the ops heartbeat sums
 * `feed.epoch_conversions` of the last minutes and alerts
 * feed-epoch-conversion, so somebody tells the customers that a stretch of
 * events was sent again. The legacy conversions are the integrators still
 * on the id walk's cursor: they fall to zero once each has polled once.
 */

const counts = { epoch_conversions: 0, legacy_conversions: 0 };

function countFeedConversion(reason: "epoch" | "legacy"): void {
  if (reason === "epoch") counts.epoch_conversions += 1;
  else counts.legacy_conversions += 1;
}

/** The minute's counts, reset: what the sampler reads at the window's end. */
function takeFeedCounts(): {
  epoch_conversions: number;
  legacy_conversions: number;
} {
  const taken = { ...counts };

  counts.epoch_conversions = 0;
  counts.legacy_conversions = 0;

  return taken;
}

registerSampleSection("feed", takeFeedCounts);

export { countFeedConversion, takeFeedCounts };
