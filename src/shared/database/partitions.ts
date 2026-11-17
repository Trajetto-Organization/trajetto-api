import { env } from "@/env";

/**
 * The partitioned tables the nightly partition-maintenance job keeps
 * (plano-escala F2-08), one entry per table: its grain, how far ahead
 * partitions are made, which ones must exist right now, and how long its
 * data is kept.
 *
 * One registry instead of a job per table: the trail is the first, and the
 * plan adds the lean trail, the event and activity shells and the queues.
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

interface PartitionedTable {
  /** The parent table, and the key of `partitions.<table>` in the metrics. */
  table: string;

  grain: PartitionGrain;

  /** Partitions kept ahead of the current one, in grains. */
  lookahead: number;

  /**
   * The partitions that must exist NOW, in grains around the current one:
   * a row for one of them is refused if it is missing (no DEFAULT
   * partition), so the run fails instead of warning.
   */
  requiredBehind: number;
  requiredAhead: number;

  /** Days of rows kept; older partitions are detached and dropped. */
  retentionDays: number;

  /**
   * Days after a partition's range ends before its rows stop changing:
   * from then on it is frozen on Sundays (VACUUM FREEZE), once.
   */
  settleDays: number;
}

/** One partition the registry wants, `from` inclusive and `to` exclusive. */
interface PlannedPartition {
  name: string;
  from: Date;
  to: Date;
  required: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
 */
function registeredPartitions(
  values: PartitionEnv = env,
): readonly PartitionedTable[] {
  return [
    {
      table: "driver_position",
      grain: "day",
      lookahead: values.DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: values.DRIVER_POSITION_RETENTION_DAYS,
      settleDays: 8,
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
 * never part of a day.
 */
function retentionCutoff(
  table: PartitionedTable,
  now: Date = new Date(),
): Date {
  return new Date(
    grainStart("day", now).getTime() - table.retentionDays * DAY_MS,
  );
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
  FREEZE_LOOKBACK_DAYS,
  addGrains,
  freezeWindow,
  grainStart,
  partitionName,
  partitionStartFromName,
  plannedPartitions,
  registeredPartitions,
  retentionCutoff,
};
export type {
  PartitionEnv,
  PartitionGrain,
  PartitionedTable,
  PlannedPartition,
};
