import { env } from "@/env";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * The partitioned tables the nightly partition-maintenance job keeps
 * (plano-escala F2-08), one entry per table: its grain, how far ahead
 * partitions are made, which ones must exist right now, and how long its
 * data is kept.
 *
 * One registry instead of a job per table: the trail was the first, the
 * lean trail came next (F2-10), the delivery trail's shell after it
 * (F2-16), and the plan adds the activity shell and the queues.
 * Each new one is an entry here, and the job, the metrics
 * (`partitions.<table>` on /health/metrics) and the alerts follow it. Every
 * table here is also in infra/sql/10-partitions.sql, which makes
 * trajetto_partitions its owner (a unit test keeps the two in step).
 *
 * Pure but for the environment it is built from: names, bounds and cutoffs
 * are computed from a given instant, in UTC. A partition's bounds are UTC
 * midnights by design, never a company's day.
 */

type PartitionGrain = "day" | "month";

/**
 * What the partition key is: a `timestamp` column (the trail's recorded_at)
 * or the row's uuid v7 id (the delivery trail's shell, plano-escala F2-16),
 * whose bounds are the smallest id each grain can carry.
 */
type PartitionKey = "timestamp" | "uuid7";

interface PartitionedTable {
  /** The parent table, and the key of `partitions.<table>` in the metrics. */
  table: string;

  grain: PartitionGrain;

  key: PartitionKey;

  /** Partitions kept ahead of the current one, in grains. */
  lookahead: number;

  /**
   * The partitions that must exist NOW, in grains around the current one:
   * a row for one of them is refused if it is missing (no DEFAULT
   * partition), so the run fails instead of warning.
   */
  requiredBehind: number;
  requiredAhead: number;

  /**
   * Days of rows kept; older partitions are detached and dropped. Null:
   * kept, the job never detaches nor drops a partition of it (the delivery
   * history, until the legal opinion of decision D3).
   */
  retentionDays: number | null;

  /**
   * Days after a partition's range ends before its rows stop changing:
   * from then on it is frozen on Sundays (VACUUM FREEZE), once.
   */
  settleDays: number;

  /**
   * "trail": with TRAIL_ARCHIVE_ENABLED, a day past the retention is copied
   * to the archive bucket and checked against archive_manifest before it is
   * detached and dropped (plano-escala F2-11). Absent: dropped as is.
   */
  archive?: "trail";
}

/** One partition the registry wants, `from` inclusive and `to` exclusive. */
interface PlannedPartition {
  name: string;
  from: Date;
  to: Date;
  required: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Months of the delivery trail's shell kept made ahead of the current one. */
const DELIVERY_EVENT_LOOKAHEAD_MONTHS = 3;

/**
 * Sundays freeze what settled in the last two weeks: one missed Sunday is
 * caught by the next one.
 */
const FREEZE_LOOKBACK_DAYS = 14;

interface PartitionEnv {
  DRIVER_POSITION_RETENTION_DAYS: number;
  DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: number;
}

/**
 * The registry, as this environment configures it.
 *
 * driver_position: daily. Yesterday, today and tomorrow must exist (a
 * replica whose clock is behind, or a ping recorded just before midnight
 * and flushed after, lands on yesterday). A week ahead by default, so six
 * missed nights in a row before anybody loses a position. Ninety days of
 * trail by default: enough to answer "onde o caminhão estava no dia 12"
 * in a dispute; the legal record of a delivery is its proof and events.
 * A day stops changing once the app's offline buffer (7 days) is past it.
 * With TRAIL_ARCHIVE_ENABLED, a day past the retention is archived to R2
 * and checked before it is dropped (F2-11), in both trail tables.
 *
 * driver_position_v2: the lean trail (plano-escala F2-10), where the
 * positions are written from the release that brought it; the same days,
 * the same lookahead and the same retention. The legacy driver_position
 * stays kept as before until a later release drops it (F2-12): the image
 * before this one writes there during a rolling deploy or after a
 * rollback, and an empty day ahead costs nothing, while a missing one
 * refuses every position of the old image.
 *
 * delivery_event_part: the shell the delivery trail moves into at the copy
 * window of wave 11 (plano-escala F2-16, F2-17), monthly on its uuid v7
 * id. Empty until then. Its months are made three ahead, because each
 * ATTACH clones the six foreign keys and takes SHARE ROW EXCLUSIVE on the
 * tables they reference (delivery, user, route...), and three months of
 * nights give that lock every chance to come at 04:10. The month behind
 * and the next one must exist (an id minted at 23:59:59.999 of the last
 * day lands in the month behind); the history before the first month is
 * the legacy partition, FROM (MINVALUE), which the job leaves alone. Kept:
 * nothing is detached or dropped until the legal opinion (decision D3).
 */
function registeredPartitions(
  values: PartitionEnv = env,
): readonly PartitionedTable[] {
  const trail = {
    grain: "day",
    key: "timestamp",
    lookahead: values.DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS,
    requiredBehind: 1,
    requiredAhead: 1,
    retentionDays: values.DRIVER_POSITION_RETENTION_DAYS,
    settleDays: 8,
    archive: "trail",
  } as const;

  return [
    { table: "driver_position", ...trail },
    { table: "driver_position_v2", ...trail },
    {
      table: "delivery_event_part",
      grain: "month",
      key: "uuid7",
      lookahead: DELIVERY_EVENT_LOOKAHEAD_MONTHS,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: null,
      settleDays: 7,
    },
  ];
}

/** The start of the grain that holds `at`: a UTC midnight, or a month's first. */
function grainStart(grain: PartitionGrain, at: Date): Date {
  return grain === "day"
    ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
    : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** `start` moved by `count` grains (negative goes back). */
function addGrains(grain: PartitionGrain, start: Date, count: number): Date {
  return grain === "day"
    ? new Date(
        Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth(),
          start.getUTCDate() + count,
        ),
      )
    : new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + count, 1),
      );
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * The name of the partition that starts at `start`: `<table>_YYYYMMDD` for
 * a day, `<table>_YYYYMM` for a month. Zero-padded, so names sort in time.
 */
function partitionName(table: PartitionedTable, start: Date): string {
  const year = pad(start.getUTCFullYear(), 4);
  const month = pad(start.getUTCMonth() + 1);

  return table.grain === "day"
    ? `${table.table}_${year}${month}${pad(start.getUTCDate())}`
    : `${table.table}_${year}${month}`;
}

/**
 * The start of a partition by its name, or null for a name the registry
 * would not have made: `driver_position_v2_…` is not a partition of
 * driver_position.
 */
function partitionStartFromName(
  table: PartitionedTable,
  name: string,
): Date | null {
  const pattern =
    table.grain === "day"
      ? new RegExp(`^${table.table}_(\\d{4})(\\d{2})(\\d{2})$`)
      : new RegExp(`^${table.table}_(\\d{4})(\\d{2})$`);
  const match = pattern.exec(name);

  if (!match) return null;

  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 1),
  ];
  const start = new Date(Date.UTC(year, month - 1, day));

  // 20261341 is not a day: Date.UTC would roll it into the next month.
  return start.getUTCMonth() === month - 1 && start.getUTCDate() === day
    ? start
    : null;
}

/** From the required ones behind through the lookahead, oldest first. */
function plannedPartitions(
  table: PartitionedTable,
  now: Date = new Date(),
): PlannedPartition[] {
  const current = grainStart(table.grain, now);
  const planned: PlannedPartition[] = [];

  for (
    let offset = -table.requiredBehind;
    offset <= table.lookahead;
    offset += 1
  ) {
    const from = addGrains(table.grain, current, offset);

    planned.push({
      name: partitionName(table, from),
      from,
      to: addGrains(table.grain, current, offset + 1),
      required: offset <= table.requiredAhead,
    });
  }

  return planned;
}

/**
 * A partition whose range ends at or before this instant is past the
 * retention: the day of the trail that is `retentionDays` old goes whole,
 * never part of a day. A kept table (no retention) answers the epoch:
 * nothing ends before it, so nothing is past it nor stuck.
 */
function retentionCutoff(
  table: PartitionedTable,
  now: Date = new Date(),
): Date {
  if (table.retentionDays === null) return new Date(0);

  return new Date(
    grainStart("day", now).getTime() - table.retentionDays * DAY_MS,
  );
}

/**
 * A partition bound as SQL, for the table's key: a `timestamp` literal in
 * UTC with no zone, or the smallest uuid v7 of that instant. Built from a
 * Date the caller computed, never from a request.
 */
function partitionBound(table: PartitionedTable, at: Date): string {
  return table.key === "uuid7"
    ? `'${uuid7Floor(at)}'`
    : `'${at.toISOString()}'`;
}

/**
 * The partitions a Sunday freezes: those whose range ended between
 * `settleDays` and `settleDays + 14` days ago.
 */
function freezeWindow(
  table: PartitionedTable,
  now: Date = new Date(),
): { endsAfter: Date; endsBy: Date } {
  const endsBy = new Date(
    grainStart("day", now).getTime() - table.settleDays * DAY_MS,
  );

  return {
    endsAfter: new Date(endsBy.getTime() - FREEZE_LOOKBACK_DAYS * DAY_MS),
    endsBy,
  };
}

export {
  DELIVERY_EVENT_LOOKAHEAD_MONTHS,
  FREEZE_LOOKBACK_DAYS,
  addGrains,
  freezeWindow,
  grainStart,
  partitionBound,
  partitionName,
  partitionStartFromName,
  plannedPartitions,
  registeredPartitions,
  retentionCutoff,
};
export type {
  PartitionEnv,
  PartitionGrain,
  PartitionKey,
  PartitionedTable,
  PlannedPartition,
};
