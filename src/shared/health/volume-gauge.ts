import database from "@/../infra/database";

import type { AlertThresholds } from "@/shared/health/alert-rules";

/**
 * The ramp's gauge (plano-escala U-12): how many deliveries the platform
 * creates, against the monthly volume a load report approved.
 *
 * The hardware has a ceiling nobody sees from the product: one VPS takes
 * the step the last capacity report in docs/desempenho approved
 * (APPROVED_GATE_MONTHLY_DELIVERIES, 10 000 a month today), and a
 * customer's ramp that walks past it finds out on the day of the peak.
 * The ops heartbeat now says it first, and only says it: nothing here
 * refuses a delivery.
 *
 * How it is counted, and why:
 *
 *  - each process counts the deliveries IT created (the panel's create, the
 *    integration's, the spreadsheet and the XML imports), right after the
 *    transaction that wrote the row commits, so a create that rolled back
 *    is never counted (the plan's risk: "tentativas que depois falham");
 *  - the count rides on the process's ops_sample row of the minute, the
 *    `deliveries` section, which resets as it is read;
 *  - the elected heartbeat sums those rows into the cluster row's
 *    `deliveries.created`: the process rows since the previous cluster row,
 *    one minute behind (a process row lands 0–15 s after its window, so
 *    the minute before is complete). Missed heartbeat minutes are summed
 *    by the next one, and no process row is summed twice;
 *  - on the quarter-hours, the cluster row also carries the 24 h and 7 day
 *    sums of the cluster rows (`last_24h`, `last_7d`), and the alerts read
 *    the newest of them: a 7 day sum every minute would read 10 000 rows a
 *    minute to move a number that changes by the day.
 *
 * An approximation by design: a process that dies mid-minute loses that
 * minute's count, and so does a minute whose ops_sample write was skipped
 * (the database already in trouble). It undercounts, never overcounts.
 * Infra numbers only: a count, never a business or a delivery id.
 */

/** The ops_sample section (process rows) and the cluster row's key. */
const VOLUME_SECTION = "deliveries";

/** The totals ride on the quarter-hour cluster rows. */
const VOLUME_TOTALS_EVERY_MINUTES = 15;

/**
 * Off the quarter-hour, the alerts read the newest totals up to this old:
 * one quarter plus slack for a missed minute or two.
 */
const VOLUME_TOTALS_MAX_AGE_MINUTES = 20;

/** A process row lands up to 15 s after its window: one minute behind. */
const PROCESS_ROW_LAG_MS = 60_000;

/** Past this gap, the previous cluster row is too old to sum from. */
const PREVIOUS_CLUSTER_ROW_MAX_AGE_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

let createdThisWindow = 0;

/**
 * Called AFTER the commit of the transaction that created the deliveries,
 * never inside it: inside, a rollback would leave the count behind.
 */
function countDeliveriesCreated(count = 1): void {
  if (!Number.isInteger(count) || count <= 0) return;

  createdThisWindow += count;
}

/** The process row's section: this window's count, reset as it is read. */
function rotateDeliveriesCreated(): { created: number } {
  const created = createdThisWindow;
  createdThisWindow = 0;

  return { created };
}

function carriesVolumeTotals(slot: Date): boolean {
  return slot.getUTCMinutes() % VOLUME_TOTALS_EVERY_MINUTES === 0;
}

interface VolumeTotals {
  /** Deliveries created in the 24 h and 7 days up to `at`. */
  last24h: number;
  last7d: number;

  /**
   * The oldest counted minute inside the 7 days. A series younger than a
   * week undercounts, and a reader of the projection needs to know.
   */
  since: Date | null;

  /** The quarter-hour these were summed at. */
  at: Date;
}

interface VolumeReading {
  /** Deliveries the process rows counted since the previous cluster row. */
  created: number;

  /**
   * The sums the alerts judge: summed at this slot on a quarter-hour, the
   * newest quarter-hour's otherwise; null when there is none.
   */
  totals: VolumeTotals | null;
}

/**
 * The process rows not yet in any cluster row: since one minute before the
 * previous cluster row (or the minute before this one, without a recent
 * one), up to one minute before this slot.
 */
async function readMinuteCreated(slot: Date): Promise<number> {
  const until = new Date(slot.getTime() - PROCESS_ROW_LAG_MS);
  const oldestPrevious = new Date(
    slot.getTime() - PREVIOUS_CLUSTER_ROW_MAX_AGE_MS,
  );
  const fallbackFrom = new Date(until.getTime() - PROCESS_ROW_LAG_MS);

  const [row] = await database.$queryRaw<Array<{ created: number | null }>>`
    WITH previous AS (
      SELECT max(ts) AS ts
      FROM ops_sample
      WHERE role = 'cluster' AND ts < ${slot} AND ts >= ${oldestPrevious}
    )
    SELECT coalesce(sum((sample.metrics->'deliveries'->>'created')::float8), 0)
      AS created
    FROM ops_sample sample, previous
    WHERE sample.role <> 'cluster'
      AND sample.ts > coalesce(
        previous.ts - interval '60 seconds',
        ${fallbackFrom}
      )
      AND sample.ts <= ${until}
  `;

  return Number(row?.created ?? 0);
}

/** The 24 h and 7 day sums of the cluster rows before the slot. */
async function sumClusterRows(
  slot: Date,
  created: number,
): Promise<VolumeTotals> {
  const weekAgo = new Date(slot.getTime() - 7 * DAY_MS);
  const dayAgo = new Date(slot.getTime() - DAY_MS);

  const [row] = await database.$queryRaw<
    Array<{ last24h: number | null; last7d: number | null; since: Date | null }>
  >`
    SELECT
      coalesce(sum(counted.created) FILTER (WHERE counted.ts > ${dayAgo}), 0)
        AS last24h,
      coalesce(sum(counted.created), 0) AS last7d,
      min(counted.ts) FILTER (WHERE counted.created IS NOT NULL) AS since
    FROM (
      SELECT ts, (metrics->'deliveries'->>'created')::float8 AS created
      FROM ops_sample
      WHERE role = 'cluster' AND ts > ${weekAgo} AND ts < ${slot}
    ) counted
  `;

  // This minute's own count is not a row yet.
  return {
    last24h: Number(row?.last24h ?? 0) + created,
    last7d: Number(row?.last7d ?? 0) + created,
    since: row?.since ? new Date(row.since) : created > 0 ? slot : null,
    at: slot,
  };
}

/** The newest quarter-hour's totals, up to 20 minutes old. */
async function readLatestTotals(slot: Date): Promise<VolumeTotals | null> {
  const from = new Date(
    slot.getTime() - VOLUME_TOTALS_MAX_AGE_MINUTES * 60_000,
  );

  const [row] = await database.$queryRaw<
    Array<{
      ts: Date;
      last24h: number | null;
      last7d: number | null;
      since: string | null;
    }>
  >`
    SELECT
      ts,
      (metrics->'deliveries'->>'last_24h')::float8 AS last24h,
      (metrics->'deliveries'->>'last_7d')::float8 AS last7d,
      metrics->'deliveries'->>'since' AS since
    FROM ops_sample
    WHERE role = 'cluster' AND ts < ${slot} AND ts > ${from}
      AND metrics->'deliveries'->>'last_7d' IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `;

  if (!row || row.last24h === null || row.last7d === null) return null;

  return {
    last24h: Number(row.last24h),
    last7d: Number(row.last7d),
    since: row.since ? new Date(row.since) : null,
    at: new Date(row.ts),
  };
}

/**
 * The heartbeat's volume reading of one elected minute: the minute's sum,
 * and the totals the alerts judge. Throws on a failed read; the caller
 * (readClusterReadings) turns that into no reading.
 */
async function readVolume(slot: Date): Promise<VolumeReading> {
  const created = await readMinuteCreated(slot);

  const totals = carriesVolumeTotals(slot)
    ? await sumClusterRows(slot, created)
    : await readLatestTotals(slot);

  return { created, totals };
}

/** The cluster row's `deliveries`: the totals only where they were summed. */
function volumeSection(
  reading: VolumeReading,
  slot: Date,
): Record<string, unknown> {
  const totals = reading.totals;
  const summedHere = totals !== null && totals.at.getTime() === slot.getTime();

  return {
    created: reading.created,
    ...(summedHere
      ? {
          last_24h: totals.last24h,
          last_7d: totals.last7d,
          since: totals.since?.toISOString() ?? null,
        }
      : {}),
  };
}

/**
 * The ramp as /health/metrics shows it (plano-escala F1-22): the newest
 * quarter-hour's sums, read like the alert reads them (up to 20 minutes
 * old), projected the alert's way (× 30/7) against the same gate and
 * ratio, so the Sistema tab and the heartbeat never disagree. Unknown is
 * null, never zero: no recent sum (OPS_SAMPLE_ENABLED=false, a series
 * younger than a quarter-hour, a heartbeat that stopped) is not "nothing
 * created". Counts and the gate only, never a business.
 */
interface VolumeGauge {
  approved_gate_monthly: number;
  gate_ratio: number;
  daily_soft_cap: number | null;
  last_24h: number | null;
  last_7d: number | null;
  projected_monthly: number | null;
  gate_percent: number | null;
  since: string | null;
  measured_at: string | null;
}

type VolumeGaugeThresholds = Pick<
  AlertThresholds,
  "approvedGateMonthlyDeliveries" | "volumeGateRatio" | "dailyDeliverySoftCap"
>;

function volumeGauge(
  totals: VolumeTotals | null,
  thresholds: VolumeGaugeThresholds,
): VolumeGauge {
  const gate = thresholds.approvedGateMonthlyDeliveries;
  const projected = totals ? (totals.last7d * 30) / 7 : null;

  return {
    approved_gate_monthly: gate,
    gate_ratio: thresholds.volumeGateRatio,
    // Infinity is "no cap" to the alert; JSON has no Infinity.
    daily_soft_cap: Number.isFinite(thresholds.dailyDeliverySoftCap)
      ? thresholds.dailyDeliverySoftCap
      : null,
    last_24h: totals?.last24h ?? null,
    last_7d: totals?.last7d ?? null,
    projected_monthly: projected === null ? null : Math.round(projected),
    // Rounded like the alert's message, so the two read the same number.
    gate_percent:
      projected === null ? null : Math.round((projected / gate) * 100),
    since: totals?.since?.toISOString() ?? null,
    measured_at: totals?.at.toISOString() ?? null,
  };
}

export {
  VOLUME_SECTION,
  VOLUME_TOTALS_EVERY_MINUTES,
  carriesVolumeTotals,
  countDeliveriesCreated,
  readLatestTotals,
  readVolume,
  rotateDeliveriesCreated,
  volumeGauge,
  volumeSection,
};
export type { VolumeGauge, VolumeReading, VolumeTotals };
