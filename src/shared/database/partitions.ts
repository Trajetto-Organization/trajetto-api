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

/** The gates a registered table may name (PartitionedTable.dropGate). */
type PartitionDropGateName = "notification-family" | "webhook-deliveries";

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
   *
   * "history": the delivery history (plano-escala F5-17). A partition past
   * the retention leaves only through the history's gate, which needs its
   * archive written again after it became due and a count that still
   * matches; without the gate it is never detached.
   */
  archive?: "trail" | "history";

  /**
   * A table that is still a plain one, and becomes partitioned only at the
   * swap of plano-escala F5-09 or at a copy window of the history (F2-17,
   * F2-18), both in prisma/post-deploy: until then the job leaves it alone,
   * and the metrics and the alerts do not judge its partitions (it has none
   * to judge). From the swap on, it is kept like any other entry.
   */
  plainUntilSwap?: boolean;

  /**
   * The empty shell a copy window fills and renames to its table
   * (plano-escala F2-16, F2-17, F2-18: delivery_event_part becomes
   * delivery_event, activity_part becomes activity). Kept like any other
   * entry while it exists, so the months the copy needs are there; once the
   * window ran it is gone on purpose, and its absence is neither a warning
   * of the job nor a runway to alert on. Its table has its own entry, plain
   * until the window (plainUntilSwap).
   */
  shellUntilWindow?: boolean;

  /**
   * Who decides that a partition past the retention may go, for a queue
   * whose rows need something first (plano-escala F5-11, F5-12): a day of
   * the notification family copies its failures to the dead letters and
   * drops its events' keys, and no queue loses a day with a row still in
   * flight. The job asks the gate (src/shared/database/partition-drop-gate.ts)
   * before each DETACH; a "no" keeps the partition attached for the next
   * night, and the partition-stuck alert counts it. Absent: the job drops
   * what is past the retention as is.
   */
  dropGate?: PartitionDropGateName;

  /**
   * Days past the retention before a partition still attached counts as
   * stuck (the partition-stuck alert); 3 when absent. The queues' follow
   * QUEUE_PARTITION_STUCK_ALERT_DAYS (F5-11): a day held by a row in
   * flight is a queue that stopped, not a lock.
   */
  stuckGraceDays?: number;

  /**
   * Storage parameters each new partition gets, as `name=value`: a
   * partitioned parent cannot hold them (Postgres refuses fillfactor and
   * the autovacuum settings on it), and `LIKE … INCLUDING …` does not copy
   * them. The queues' are the ones their plain tables have today
   * (tests/E2E/raw-sql-objects.test.ts, STORAGE_PARAMETERS).
   */
  reloptions?: readonly string[];
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
  /** Days of the queues' partitions made ahead (F5-07); 7 when absent. */
  QUEUE_PARTITION_LOOKAHEAD_DAYS?: number;
  /** Days of the notification family kept (F5-11); 30 when absent. */
  OUTBOX_PUBLISHED_RETENTION_DAYS?: number;
  /** Days past the retention before a queue day is stuck; 3 when absent. */
  QUEUE_PARTITION_STUCK_ALERT_DAYS?: number;
  /** Days of the webhook ledger kept (F5-12); 31 when absent. */
  WEBHOOK_DELIVERY_RETENTION_DAYS?: number;
  /** Days the bell keeps an unread notification (F5-14); 180 when absent. */
  NOTIFICATION_UNREAD_RETENTION_DAYS?: number;
  /** The history's DROP (F5-17); off when absent. */
  HISTORY_DROP_ENABLED?: boolean;
  /** Months of history kept attached (F5-17); 24 when absent. */
  HISTORY_ATTACHED_MONTHS?: number;
}

/** The history's attached months when the environment does not say (F5-17). */
const HISTORY_ATTACHED_MONTHS_DEFAULT = 24;

/**
 * The history's retention, in days, from its attached months: 31 a month,
 * so a partition never leaves before that many calendar months. Null (kept)
 * unless the DROP is switched on.
 */
function historyRetentionDays(values: PartitionEnv): number | null {
  if (values.HISTORY_DROP_ENABLED !== true) return null;

  return (
    (values.HISTORY_ATTACHED_MONTHS ?? HISTORY_ATTACHED_MONTHS_DEFAULT) * 31
  );
}

/** The queues' lookahead when the environment does not say (F5-07). */
const QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT = 7;

/** The notification family's retention when the environment does not say. */
const OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT = 30;

/** The queues' grace before partition-stuck when the environment does not say. */
const QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT = 3;

/** Months of the bell's partitions kept made ahead of the current one. */
const NOTIFICATION_LOOKAHEAD_MONTHS = 2;

/** The bell's unread retention when the environment does not say (F5-14). */
const NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT = 180;

/**
 * The webhook ledger's retention when the environment does not say: the
 * replay window (REPLAY_WINDOW_DAYS, 30) plus a day of grace.
 */
const WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT = 31;

/**
 * The queues' storage parameters, one partition at a time: a claim rewrites
 * a row in place (fillfactor 70 leaves room for the HOT update) and their
 * dead rows are vacuumed early and cheaply. The receipts are appended and
 * rarely updated, and keep the defaults.
 */
const QUEUE_RELOPTIONS = [
  "autovacuum_vacuum_scale_factor=0.01",
  "autovacuum_analyze_scale_factor=0.01",
  "autovacuum_vacuum_cost_delay=2",
  "fillfactor=70",
] as const;

const WEBHOOK_DELIVERY_RELOPTIONS = [
  "autovacuum_vacuum_scale_factor=0.01",
  "autovacuum_analyze_scale_factor=0.01",
  "fillfactor=70",
] as const;

/**
 * The four queues (plano-escala F5-07), daily by their uuid v7 id from the
 * swap of F5-09 on. Every id written there is a v7
 * (tests/unitaires/database/queue-ids-v7-guard.test.ts): a v4 would land
 * in any day's range. Yesterday, today and tomorrow must exist (an id of a
 * delivery carries its event's millisecond, and a replica's clock may be
 * behind); a week ahead by default. A day stops changing once its rows
 * settle; the receipts' days settle last (a provider reports for days).
 *
 * The notification family (the events, their deliveries and the receipts,
 * one day of ids each) leaves by day after OUTBOX_PUBLISHED_RETENTION_DAYS
 * (F5-11), through the notification-family gate: never with a row in
 * flight, its failures copied to the dead letters and its keys dropped
 * first. The webhook ledger leaves by day after
 * WEBHOOK_DELIVERY_RETENTION_DAYS (F5-12, at least the replay window plus
 * a day), through the webhook-deliveries gate: never a day the dispatcher
 * still owns a row of.
 */
function queuePartitions(values: PartitionEnv): PartitionedTable[] {
  const queue = {
    grain: "day",
    key: "uuid7",
    lookahead:
      values.QUEUE_PARTITION_LOOKAHEAD_DAYS ??
      QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT,
    requiredBehind: 1,
    requiredAhead: 1,
    retentionDays: null,
    settleDays: 3,
    plainUntilSwap: true,
    stuckGraceDays:
      values.QUEUE_PARTITION_STUCK_ALERT_DAYS ??
      QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT,
  } as const;
  const family = {
    ...queue,
    retentionDays:
      values.OUTBOX_PUBLISHED_RETENTION_DAYS ??
      OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT,
    dropGate: "notification-family",
  } as const;

  return [
    { table: "domain_outbox_event", ...family, reloptions: QUEUE_RELOPTIONS },
    {
      table: "notification_delivery",
      ...family,
      reloptions: QUEUE_RELOPTIONS,
    },
    { table: "notification_provider_receipt", ...family, settleDays: 8 },
    {
      table: "webhook_delivery",
      ...queue,
      retentionDays:
        values.WEBHOOK_DELIVERY_RETENTION_DAYS ??
        WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT,
      dropGate: "webhook-deliveries",
      reloptions: WEBHOOK_DELIVERY_RELOPTIONS,
    },
  ];
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
 * The copy window (prisma/post-deploy/30-delivery-event-window.sql) renames
 * it to delivery_event, its months to delivery_event_YYYYMM and the legacy
 * partition to delivery_event_older: from then on the shell is gone
 * (shellUntilWindow), and the same months are kept under the
 * delivery_event entry, a plain table until that night.
 *
 * activity_part and activity (plano-escala F2-18): the activity trail's
 * shell and the table it becomes at the same window
 * (prisma/post-deploy/31-activity-window.sql), kept exactly like the
 * delivery trail's: monthly on the uuid v7 id, three months ahead (each
 * ATTACH clones the foreign keys to business and user), nothing detached
 * by the job. The opt-in purge of ACTIVITY_RETENTION_DAYS keeps deleting
 * in batches.
 *
 * Both history tables, once partitioned, leave a partition only with
 * HISTORY_DROP_ENABLED (plano-escala F5-17, off until the lawyer's
 * opinion), HISTORY_ATTACHED_MONTHS (24) after it ends, and only through
 * the history's gate: archived again after it became due, the manifest
 * adding up to a count taken that night (shared/archive/history-archive.ts).
 * Their foreign keys stay: a DETACH keeps them on the detached table, and
 * its DROP takes them with it.
 *
 * The four queues: see queuePartitions. Plain tables until the swap.
 *
 * notification, the bell (plano-escala F5-15): monthly on its uuid v7 id
 * (a notification's id is its delivery's, its event's millisecond) from
 * the swap of prisma/post-deploy/20-notification-partition-swap.sql on, a
 * plain table until then. Two months ahead; the month behind and the next
 * one must exist (an event of the last day of a month notifies in the
 * next). A month leaves whole once it is past the unread retention
 * (NOTIFICATION_UNREAD_RETENTION_DAYS, 180 days): by then every row in it
 * is past both retentions, read or not, and nothing in the bell is ever in
 * flight, so no gate. The nightly purge in batches keeps taking the read
 * rows past their 90 days inside the months still kept.
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

  const deliveryTrail = {
    grain: "month",
    key: "uuid7",
    lookahead: DELIVERY_EVENT_LOOKAHEAD_MONTHS,
    requiredBehind: 1,
    requiredAhead: 1,
    retentionDays: null,
    settleDays: 7,
  } as const;

  return [
    { table: "driver_position", ...trail },
    { table: "driver_position_v2", ...trail },
    { table: "delivery_event_part", ...deliveryTrail, shellUntilWindow: true },
    {
      table: "delivery_event",
      ...deliveryTrail,
      plainUntilSwap: true,
      archive: "history",
      retentionDays: historyRetentionDays(values),
    },
    { table: "activity_part", ...deliveryTrail, shellUntilWindow: true },
    {
      table: "activity",
      ...deliveryTrail,
      plainUntilSwap: true,
      archive: "history",
      retentionDays: historyRetentionDays(values),
    },
    ...queuePartitions(values),
    {
      table: "notification",
      grain: "month",
      key: "uuid7",
      lookahead: NOTIFICATION_LOOKAHEAD_MONTHS,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays:
        values.NOTIFICATION_UNREAD_RETENTION_DAYS ??
        NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT,
      settleDays: 7,
      plainUntilSwap: true,
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
  HISTORY_ATTACHED_MONTHS_DEFAULT,
  NOTIFICATION_LOOKAHEAD_MONTHS,
  NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT,
  OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT,
  QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT,
  QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT,
  WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT,
  FREEZE_LOOKBACK_DAYS,
  addGrains,
  freezeWindow,
  grainStart,
  historyRetentionDays,
  partitionBound,
  partitionName,
  partitionStartFromName,
  plannedPartitions,
  registeredPartitions,
  retentionCutoff,
};
export type {
  PartitionDropGateName,
  PartitionEnv,
  PartitionGrain,
  PartitionKey,
  PartitionedTable,
  PlannedPartition,
};
