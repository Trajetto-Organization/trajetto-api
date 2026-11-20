/**
 * The index usage report of /health/metrics (plano-escala F2-23), pure.
 *
 * Every index of a hot table is paid by every write of it, read or not.
 * The report lists each index of the hot tables (HOT_TABLES, by partition
 * root, the partitions' indexes summed under the parent's) with its scans
 * since the statistics were last reset, its last scan (Postgres 16 keeps
 * it, last_idx_scan) and its size, and flags the ones nobody read in
 * INDEX_USAGE_WINDOW_DAYS.
 *
 * An index is a candidate (`unused`) only when it is neither a primary key
 * nor a unique (a constraint or an upsert needs it whatever the scans say)
 * and either its last scan is older than the window, or it was never
 * scanned in a window of the counters that is at least that long. With
 * counters that were never reset, since when they run is unknown and a
 * zero proves nothing (an index created yesterday reads zero too): no
 * candidate then, only the numbers. A candidate is not cut here: it is cut
 * by hand, one per release, with two readings 30 days apart in the commit
 * (prisma/concurrent/README.md, "Um índice que sai").
 */

/** How long an index must go unread before it is a candidate. */
const INDEX_USAGE_WINDOW_DAYS = 30;

/** How long one reading is served (the scans move by the day). */
const INDEX_USAGE_TTL_MS = 15 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One index as indexUsageSql returns it. */
interface IndexUsageRow {
  table_name: string;
  index_name: string;
  scans: number;
  last_scan_at: string | null;
  bytes: number;
  is_primary: boolean;
  is_unique: boolean;
}

interface IndexUsageQueryRow {
  stats_reset_at: Date | string | null;
  indexes: IndexUsageRow[] | null;
}

interface IndexUsageEntry {
  table: string;
  index: string;
  scans: number;
  last_scan_at: string | null;
  bytes: number;
  primary: boolean;
  unique: boolean;
  unused: boolean;
}

interface IndexUsage {
  /** When this database's statistics were last reset; null if never. */
  stats_reset_at: string | null;

  /** Whole days the counters cover; null when unknown (never reset). */
  window_days: number | null;

  indexes: IndexUsageEntry[];

  /** The names of the candidates, for a glance. */
  unused: string[];

  /** When the reading was taken: up to 15 minutes old. */
  measured_at: string;
}

function finite(value: unknown): number {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function indexUsageOf(
  row: IndexUsageQueryRow | undefined,
  now: Date = new Date(),
): IndexUsage {
  const resetAt = iso(row?.stats_reset_at);
  const windowDays =
    resetAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - Date.parse(resetAt)) / DAY_MS));
  const cutoff = now.getTime() - INDEX_USAGE_WINDOW_DAYS * DAY_MS;

  const indexes = (row?.indexes ?? []).map((index): IndexUsageEntry => {
    const scans = finite(index.scans);
    const lastScanAt = iso(index.last_scan_at);
    const constraint = index.is_primary === true || index.is_unique === true;
    const unreadSince =
      lastScanAt !== null
        ? Date.parse(lastScanAt) < cutoff
        : scans === 0 &&
          windowDays !== null &&
          windowDays >= INDEX_USAGE_WINDOW_DAYS;

    return {
      table: index.table_name,
      index: index.index_name,
      scans,
      last_scan_at: lastScanAt,
      bytes: finite(index.bytes),
      primary: index.is_primary === true,
      unique: index.is_unique === true,
      unused: !constraint && unreadSince,
    };
  });

  return {
    stats_reset_at: resetAt,
    window_days: windowDays,
    indexes,
    unused: indexes.filter((index) => index.unused).map((index) => index.index),
    measured_at: now.toISOString(),
  };
}

export { INDEX_USAGE_TTL_MS, INDEX_USAGE_WINDOW_DAYS, indexUsageOf };
export type { IndexUsage, IndexUsageEntry, IndexUsageQueryRow, IndexUsageRow };
