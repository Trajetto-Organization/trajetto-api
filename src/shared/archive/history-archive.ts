import { v7 as uuidV7 } from "uuid";

import { logger } from "@/shared/logging/logger";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { ARCHIVE_PLATFORM_SUBJECT } from "./archive-settings";
import type { ArchiveStorage } from "./archive-storage";
import {
  writeGzipObject,
  type ArchiveDatabase,
  type ArchiveVerdict,
} from "./trail-archive";

const log = logger.child({ component: "history-archive" });

/**
 * The delivery history's archive (plano-escala F5-16): every closed month
 * of delivery_event and activity copied to the archive bucket, one gzipped
 * CSV per company, at `archive/<table>/<yyyymm>/<businessId>.csv.gz`, and
 * written down in archive_manifest with its row count and the sha256 of its
 * bytes. The month is checked as a whole: archive_partition records it only
 * when the manifest's rows add up to a count of the month taken after the
 * uploads, with nothing PENDING.
 *
 * The unit is a partition of the table as the copy window of wave 11 made
 * it (F2-17, F2-18): a month, `<table>_YYYYMM`, from the smallest uuid v7
 * of its first day to that of the next month's; and the history from
 * before the window, `<table>_older`, FROM (MINVALUE), archived the same
 * way under `archive/<table>/older/`. Nothing is archived while the table
 * is still the plain one: its ids are not all v7.
 *
 * Nothing here deletes a row of the database: the archive is a copy, and
 * the months stay attached (the DROP of F5-17 is a separate, later step,
 * off until the lawyer's opinion). The months are frozen by the Sunday
 * VACUUM FREEZE of partition-maintenance, as every settled partition is.
 *
 * As the trail's (trail-archive.ts), crash-safe by construction: a
 * company's manifest row is PENDING, with its key, before the first byte
 * goes up, ARCHIVED after; the key is fixed by the month and the company,
 * and a rewrite replaces the object whole. A company whose ARCHIVED row is
 * up to date is not uploaded again, so a run cut by its slice resumes.
 *
 * "Up to date" is more than "the same count", because the history is
 * rewritten in place after the fact:
 *  - a person anonymized (USER_ANONYMIZE, decision D49) has their name
 *    scrubbed from activity and their phone cleared from delivery_event:
 *    a company with an anonymization finished after its object was written
 *    is written again from the scrubbed rows, so the archive never keeps
 *    what the database no longer holds;
 *  - `rewriteBefore` (the DROP's final pass, F5-17): every object written
 *    before that instant is written again.
 *
 * Who the rows are of: the company of the row. activity also has rows of
 * no company (the platform's, and those of a company deleted since, whose
 * businessId went NULL with it): they go under `_platform`, which no
 * company's exit ever deletes.
 */

type HistoryTable = "delivery_event" | "activity";

interface HistorySource {
  table: HistoryTable;
  /** The CSV's columns: every column of the table, in Prisma's order. */
  columns: readonly string[];
  /**
   * How a company's rows are paged: by id on delivery_event's
   * (businessId, id) index; by (created_at, id) on activity's
   * (businessId, created_at), the only one it has by company.
   */
  order: "id" | "created_at";
}

/**
 * delivery_event's columns but txid, which Prisma never reads (`@ignore`):
 * it is the commit order of the integration feed, meaningless once the
 * month is out of the database.
 */
const DELIVERY_EVENT_ARCHIVE_COLUMNS = [
  "id",
  "type",
  "latitude",
  "longitude",
  "photo",
  "signature",
  "received_by",
  "actor",
  "device",
  "note",
  "status_from",
  "status_to",
  "reasonId",
  "client_submission_id",
  "deliveryId",
  "businessId",
  "routeId",
  "device_id",
  "photo_taken_at",
  "gps_address",
  "gps_address_source",
  "gps_geocoded_at",
  "distance_m",
  "accuracy_m",
  "geofence_outcome",
  "occurrenceId",
  "reportedById",
  "apiKeyId",
  "occurred_at",
  "created_at",
] as const;

const ACTIVITY_ARCHIVE_COLUMNS = [
  "id",
  "type",
  "action",
  "entityId",
  "description",
  "status",
  "businessId",
  "tenantName",
  "visibilityLevel",
  "performingUserRole",
  "performedBy",
  "deliveryId",
  "created_at",
  "updated_at",
] as const;

const HISTORY_SOURCES: Readonly<Record<HistoryTable, HistorySource>> = {
  delivery_event: {
    table: "delivery_event",
    columns: DELIVERY_EVENT_ARCHIVE_COLUMNS,
    order: "id",
  },
  activity: {
    table: "activity",
    columns: ACTIVITY_ARCHIVE_COLUMNS,
    order: "created_at",
  },
};

function historySourceOf(table: string): HistorySource | null {
  return HISTORY_SOURCES[table as HistoryTable] ?? null;
}

/** The subject of activity's rows of no company. */
const PLATFORM_SUBJECT = ARCHIVE_PLATFORM_SUBJECT;

/** Rows per page of a company's month. */
const HISTORY_ARCHIVE_PAGE_SIZE = 5_000;

/** Months a night hands to the jobs, per table: a backlog takes nights. */
const HISTORY_ARCHIVE_MONTHS_PER_NIGHT = 2;

/** Days after a month ends before it is archived (the partition's settle). */
const HISTORY_ARCHIVE_SETTLE_DAYS = 7;

/**
 * activity is paged by created_at, and a row's id and created_at come from
 * two clocks a few milliseconds apart (the id from the app, created_at
 * from the database): the month's rows are read with this much created_at
 * on each side of the id range, which the id range then cuts exactly.
 */
const CREATED_AT_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One partition of a history table: `from` is -Infinity for `_older`. */
interface HistoryPartition {
  name: string;
  from: number;
  to: number;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** `202611` for `delivery_event_202611`, `older` for `delivery_event_older`. */
function historyPeriod(source: HistorySource, name: string): string | null {
  const match = new RegExp(`^${source.table}_(\\d{6}|older)$`).exec(name);

  return match ? match[1] : null;
}

/** `archive/<table>/<yyyymm|older>/<subject>.csv.gz`. */
function historyArchiveKey(
  source: HistorySource,
  partitionName: string,
  subject: string,
): string {
  const period = historyPeriod(source, partitionName);

  if (!period) {
    throw new Error(`${partitionName} não é uma partição de ${source.table}`);
  }

  return `archive/${source.table}/${period}/${subject}.csv.gz`;
}

/**
 * A CSV cell of the history: empty and unquoted for NULL, quoted for an
 * empty string and for anything with a comma, a quote or a line break, so
 * a restore tells NULL from "" (archive-restore.ts).
 */
function historyCsvCell(value: string | null): string {
  if (value === null) return "";

  return value === "" || /[",\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function historyCsvLine(values: ReadonlyArray<string | null>): string {
  return `${values.map(historyCsvCell).join(",")}\n`;
}

/** Every column as Postgres renders it in text: exact, and castable back. */
function selectList(source: HistorySource): string {
  return source.columns
    .map((column) => `${quote(column)}::text AS ${quote(column)}`)
    .join(", ");
}

/** The partition's id range as SQL, with its bind parameters. */
function idRange(
  partition: HistoryPartition,
  first: number,
): { sql: string; params: string[] } {
  const params: string[] = [uuid7Floor(partition.to)];
  let sql = `"id" < $${first}`;

  if (Number.isFinite(partition.from)) {
    params.push(uuid7Floor(partition.from));
    sql += ` AND "id" >= $${first + 1}`;
  }

  return { sql, params };
}

interface CompanyMonth {
  subject: string;
  rows: number;
}

/** Which companies the partition holds, and how many rows each. */
async function subjectsOf(
  db: ArchiveDatabase,
  source: HistorySource,
  partition: HistoryPartition,
): Promise<CompanyMonth[]> {
  const range = idRange(partition, 1);
  const rows = await db.$queryRawUnsafe<
    Array<{ subject: string; rows: number }>
  >(
    `SELECT coalesce("businessId"::text, '${PLATFORM_SUBJECT}') AS subject,
            count(*)::int AS rows
       FROM ${quote(source.table)}
      WHERE ${range.sql}
      GROUP BY 1
      ORDER BY 1`,
    ...range.params,
  );

  return rows.map((row) => ({ subject: row.subject, rows: Number(row.rows) }));
}

/** The company's rows of the partition, as CSV text, page by page. */
async function* subjectCsv(
  db: ArchiveDatabase,
  source: HistorySource,
  partition: HistoryPartition,
  subject: string,
  pageSize: number,
  counted: { rows: number },
): AsyncGenerator<string> {
  yield historyCsvLine([...source.columns]);

  const owner =
    subject === PLATFORM_SUBJECT
      ? { sql: `"businessId" IS NULL`, params: [] as string[] }
      : { sql: `"businessId" = $1`, params: [subject] };
  const range = idRange(partition, owner.params.length + 1);
  const base = [...owner.params, ...range.params];

  // activity: the created_at window that holds the id range (see the slack).
  const window: { sql: string; params: string[] } =
    source.order === "created_at" && Number.isFinite(partition.from)
      ? {
          sql: ` AND "created_at" >= $${base.length + 1}::timestamp AND "created_at" < $${base.length + 2}::timestamp`,
          params: [
            new Date(partition.from - CREATED_AT_SLACK_MS).toISOString(),
            new Date(partition.to + CREATED_AT_SLACK_MS).toISOString(),
          ],
        }
      : { sql: "", params: [] };

  let after: { id: string; created_at: string } | null = null;

  for (;;) {
    const params = [...base, ...window.params];
    let keyset = "";

    if (after) {
      if (source.order === "id") {
        params.push(after.id);
        keyset = ` AND "id" > $${params.length}`;
      } else {
        params.push(after.created_at, after.id);
        keyset = ` AND ("created_at", "id") > ($${params.length - 1}::timestamp, $${params.length})`;
      }
    }

    const orderBy = source.order === "id" ? `"id"` : `"created_at", "id"`;
    const rows = await db.$queryRawUnsafe<Array<Record<string, string | null>>>(
      `SELECT ${selectList(source)}
         FROM ${quote(source.table)}
        WHERE ${owner.sql} AND ${range.sql}${window.sql}${keyset}
        ORDER BY ${orderBy}
        LIMIT ${pageSize}`,
      ...params,
    );

    if (rows.length === 0) break;

    counted.rows += rows.length;
    yield rows
      .map((row) => historyCsvLine(source.columns.map((c) => row[c] ?? null)))
      .join("");

    if (rows.length < pageSize) break;

    const last = rows[rows.length - 1];

    after = { id: String(last.id), created_at: String(last.created_at) };
  }
}

/**
 * A company that keeps its archive: one that exists and is not being
 * purged, or the platform's rows. From PURGING on, its rows are a deleted
 * company's (plano-escala F3-26a): SKIPPED, as in the trail's archive.
 */
function keptCompany(alias: string): string {
  return `(${alias}."purge_state" IS NULL OR ${alias}."purge_state" = 'SCHEDULED'::"BusinessPurgeState")`;
}

interface ManifestRow {
  business_id: string;
  status: "PENDING" | "ARCHIVED" | "SKIPPED";
  row_count: number | null;
  object_key: string;
  archived_at: Date | null;
}

interface HistoryArchiveOptions {
  db: ArchiveDatabase;
  storage: ArchiveStorage;
  /** Epoch ms past which no new company is started (the job's slice). */
  deadline: number;
  now?: () => number;
  pageSize?: number;
  /** Every object written before this instant is written again (F5-17). */
  rewriteBefore?: Date;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * When each of these companies last had a person anonymized (D49): an
 * object written before that holds what the database scrubbed.
 */
async function lastAnonymizations(
  db: ArchiveDatabase,
  subjects: readonly string[],
): Promise<Map<string, number>> {
  if (subjects.length === 0) return new Map();

  const rows = await db.$queryRawUnsafe<
    Array<{ business_id: string; at: Date }>
  >(
    `SELECT "businessId" AS business_id, max("finished_at") AS at
       FROM "background_job"
      WHERE "kind" = 'USER_ANONYMIZE'::"BackgroundJobKind"
        AND "status" = 'SUCCEEDED'::"BackgroundJobStatus"
        AND "businessId" = ANY($1::text[])
      GROUP BY 1`,
    [...subjects],
  );

  return new Map(
    rows
      .filter((row) => row.at)
      .map((row) => [row.business_id, new Date(row.at).getTime()]),
  );
}

/**
 * Archives what is missing or stale of one partition and checks the whole:
 * verified only when nothing is PENDING and the manifest adds up to a count
 * taken AFTER the uploads. Throws when the database or the bucket fails;
 * the job retries.
 */
async function archiveHistoryPartition(
  source: HistorySource,
  partition: HistoryPartition,
  options: HistoryArchiveOptions,
): Promise<ArchiveVerdict> {
  const { db, storage, deadline } = options;
  const now = options.now ?? Date.now;
  const pageSize = options.pageSize ?? HISTORY_ARCHIVE_PAGE_SIZE;
  const rewriteBefore = options.rewriteBefore?.getTime() ?? 0;

  const subjects = await subjectsOf(db, source, partition);
  const companies = subjects
    .map((each) => each.subject)
    .filter((subject) => subject !== PLATFORM_SUBJECT);

  const kept = new Set([
    PLATFORM_SUBJECT,
    ...(companies.length === 0
      ? []
      : (
          await db.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT b."id" FROM "business" b
              WHERE b."id" = ANY($1::text[]) AND ${keptCompany("b")}`,
            companies,
          )
        ).map((row) => row.id)),
  ]);

  const anonymized = await lastAnonymizations(db, companies);

  const manifest = new Map(
    (
      await db.$queryRawUnsafe<ManifestRow[]>(
        `SELECT "businessId" AS business_id, "status"::text AS status,
                "row_count", "object_key", "archived_at"
           FROM "archive_manifest"
          WHERE "partition_name" = $1`,
        partition.name,
      )
    ).map((row) => [row.business_id, row]),
  );

  let written = 0;
  let outOfTime = false;

  for (const { subject, rows } of subjects) {
    const key = historyArchiveKey(source, partition.name, subject);
    const recorded = manifest.get(subject);

    if (!kept.has(subject)) {
      if (recorded?.status === "SKIPPED" && recorded.row_count === rows) {
        continue;
      }

      // Archived before the company left: that object goes too.
      if (recorded && recorded.status !== "SKIPPED") {
        await storage.deleteMany([recorded.object_key]);
      }

      await db.$executeRawUnsafe(
        `INSERT INTO "archive_manifest"
           ("id", "source_table", "partition_name", "businessId", "object_key",
            "status", "row_count", "created_at", "archived_at")
         VALUES ($1, $2, $3, $4, $5, 'SKIPPED'::"ArchiveObjectStatus", $6,
                 $7::timestamp, $7::timestamp)
         ON CONFLICT ("partition_name", "businessId") DO UPDATE
           SET "status" = 'SKIPPED'::"ArchiveObjectStatus",
               "row_count" = EXCLUDED."row_count",
               "byte_size" = NULL,
               "sha256" = NULL,
               "archived_at" = EXCLUDED."archived_at"`,
        uuidV7(),
        source.table,
        partition.name,
        subject,
        key,
        rows,
        iso(now()),
      );

      continue;
    }

    const archivedAt = recorded?.archived_at
      ? new Date(recorded.archived_at).getTime()
      : 0;

    if (
      recorded?.status === "ARCHIVED" &&
      recorded.row_count === rows &&
      archivedAt >= rewriteBefore &&
      archivedAt > (anonymized.get(subject) ?? 0)
    ) {
      continue;
    }

    if (now() >= deadline) {
      outOfTime = true;
      break;
    }

    // The key is known before the first byte goes up; a stale ARCHIVED row
    // goes back to PENDING until its new object is whole.
    await db.$executeRawUnsafe(
      `INSERT INTO "archive_manifest"
         ("id", "source_table", "partition_name", "businessId", "object_key",
          "status", "created_at")
       VALUES ($1, $2, $3, $4, $5, 'PENDING'::"ArchiveObjectStatus", $6::timestamp)
       ON CONFLICT ("partition_name", "businessId") DO UPDATE
         SET "status" = 'PENDING'::"ArchiveObjectStatus",
             "object_key" = EXCLUDED."object_key"`,
      uuidV7(),
      source.table,
      partition.name,
      subject,
      key,
      iso(now()),
    );

    const counted = { rows: 0 };
    const object = await writeGzipObject(
      storage,
      key,
      subjectCsv(db, source, partition, subject, pageSize, counted),
    );

    await db.$executeRawUnsafe(
      `UPDATE "archive_manifest"
          SET "status" = 'ARCHIVED'::"ArchiveObjectStatus",
              "object_key" = $3,
              "row_count" = $4,
              "byte_size" = $5,
              "sha256" = $6,
              "archived_at" = $7::timestamp
        WHERE "partition_name" = $1 AND "businessId" = $2`,
      partition.name,
      subject,
      key,
      counted.rows,
      object.bytes,
      object.sha256,
      iso(now()),
    );

    written += 1;
  }

  // A company whose rows all left the partition since it was archived (a
  // delivery deleted, say): its row would make the sum exceed the count.
  const present = new Set(subjects.map((each) => each.subject));

  for (const [subject, recorded] of manifest) {
    if (present.has(subject) || outOfTime) continue;

    if (recorded.status !== "SKIPPED") {
      await storage.deleteMany([recorded.object_key]);
    }

    await db.$executeRawUnsafe(
      `DELETE FROM "archive_manifest"
        WHERE "partition_name" = $1 AND "businessId" = $2`,
      partition.name,
      subject,
    );
  }

  const range = idRange(partition, 1);
  const [actual] = await db.$queryRawUnsafe<Array<{ rows: number }>>(
    `SELECT count(*)::bigint AS rows FROM ${quote(source.table)} WHERE ${range.sql}`,
    ...range.params,
  );
  const [totals] = await db.$queryRawUnsafe<
    Array<{
      manifest_rows: number;
      pending: number;
      objects: number;
      skipped_rows: number;
    }>
  >(
    `SELECT coalesce(sum("row_count"), 0)::bigint AS manifest_rows,
            count(*) FILTER (WHERE "status" = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE "status" = 'ARCHIVED')::int AS objects,
            coalesce(sum("row_count") FILTER (WHERE "status" = 'SKIPPED'), 0)::bigint AS skipped_rows
       FROM "archive_manifest"
      WHERE "partition_name" = $1`,
    partition.name,
  );

  const rows = Number(actual?.rows ?? 0);
  const manifestRows = Number(totals?.manifest_rows ?? 0);
  const pending = Number(totals?.pending ?? 0);

  if (outOfTime || pending > 0 || manifestRows !== rows) {
    return {
      verified: false,
      reason: outOfTime ? "budget" : "mismatch",
      rows,
      manifestRows,
      pending,
      written,
    };
  }

  const objects = Number(totals?.objects ?? 0);

  await db.$executeRawUnsafe(
    `INSERT INTO "archive_partition"
       ("partition_name", "source_table", "row_count", "objects", "verified_at")
     VALUES ($1, $2, $3, $4, $5::timestamp)
     ON CONFLICT ("partition_name") DO UPDATE
       SET "row_count" = EXCLUDED."row_count",
           "objects" = EXCLUDED."objects",
           "verified_at" = EXCLUDED."verified_at"`,
    partition.name,
    source.table,
    rows,
    objects,
    iso(now()),
  );

  return {
    verified: true,
    rows,
    objects,
    skippedRows: Number(totals?.skipped_rows ?? 0),
    written,
  };
}

/** An attached partition as partition-maintenance reads it. */
interface AttachedHistoryPartition {
  name: string;
  from: number | null;
  to: number | null;
  detachPending: boolean;
}

/**
 * The partitions of a history table a night hands to the archive jobs:
 * closed and settled (HISTORY_ARCHIVE_SETTLE_DAYS past their end), not yet
 * verified, or verified before a company of theirs had someone anonymized;
 * oldest first, at most `limit`.
 */
async function historyPartitionsDue(
  db: ArchiveDatabase,
  source: HistorySource,
  attached: readonly AttachedHistoryPartition[],
  {
    now = Date.now(),
    limit = HISTORY_ARCHIVE_MONTHS_PER_NIGHT,
  }: { now?: number; limit?: number } = {},
): Promise<HistoryPartition[]> {
  const settled = attached
    .filter(
      (partition) =>
        !partition.detachPending &&
        partition.to !== null &&
        Number.isFinite(partition.to) &&
        partition.to + HISTORY_ARCHIVE_SETTLE_DAYS * DAY_MS <= now &&
        historyPeriod(source, partition.name) !== null,
    )
    .map((partition) => ({
      name: partition.name,
      from: partition.from ?? Number.NEGATIVE_INFINITY,
      to: partition.to as number,
    }))
    .sort((a, b) => a.to - b.to);

  if (settled.length === 0) return [];

  const names = settled.map((partition) => partition.name);
  const verified = new Set(
    (
      await db.$queryRawUnsafe<Array<{ partition_name: string }>>(
        `SELECT "partition_name" FROM "archive_partition"
          WHERE "source_table" = $1 AND "partition_name" = ANY($2::text[])`,
        source.table,
        names,
      )
    ).map((row) => row.partition_name),
  );
  const stale = new Set(
    (
      await db.$queryRawUnsafe<Array<{ partition_name: string }>>(
        `SELECT DISTINCT m."partition_name"
           FROM "archive_manifest" m
           JOIN "background_job" j
             ON j."businessId" = m."businessId"
            AND j."kind" = 'USER_ANONYMIZE'::"BackgroundJobKind"
            AND j."status" = 'SUCCEEDED'::"BackgroundJobStatus"
            AND j."finished_at" > coalesce(m."archived_at", m."created_at")
          WHERE m."source_table" = $1
            AND m."status" = 'ARCHIVED'::"ArchiveObjectStatus"
            AND m."partition_name" = ANY($2::text[])`,
        source.table,
        names,
      )
    ).map((row) => row.partition_name),
  );

  return settled
    .filter(
      (partition) => !verified.has(partition.name) || stale.has(partition.name),
    )
    .slice(0, limit);
}

/** What partition-maintenance asks of the history archive (F5-16). */
interface HistoryArchiveScheduler {
  /** Hands the due partitions of a partitioned history table to the jobs. */
  enqueueDue(
    table: string,
    attached: readonly AttachedHistoryPartition[],
  ): Promise<number>;
}

interface HistoryArchiveSchedulerOptions {
  db: ArchiveDatabase;
  /** False: enabled without the bucket or the token (`missing` says which). */
  configured: boolean;
  missing?: readonly string[];
  enqueue: (table: string, partition: HistoryPartition) => Promise<void>;
  now?: () => number;
}

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();

/** Never throws: a failure is logged, and the next night tries again. */
function createHistoryArchiveScheduler(
  options: HistoryArchiveSchedulerOptions,
): HistoryArchiveScheduler {
  const now = options.now ?? Date.now;
  let warnedUnconfigured = false;

  return {
    async enqueueDue(table, attached) {
      const source = historySourceOf(table);

      if (!source) return 0;

      if (!options.configured) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          log.warn(
            { table, missing: options.missing ?? [] },
            "history archive enabled but not configured: nothing archived",
          );
        }

        return 0;
      }

      try {
        const due = await historyPartitionsDue(options.db, source, attached, {
          now: now(),
        });

        for (const partition of due) await options.enqueue(table, partition);

        if (due.length > 0) {
          log.info(
            { table, partitions: due.map((partition) => partition.name) },
            "history partitions handed to their archive jobs",
          );
        }

        return due.length;
      } catch (error) {
        log.warn(
          { table, error: errorMessage(error) },
          "history archive could not be scheduled; the next night tries again",
        );

        return 0;
      }
    },
  };
}

export {
  ACTIVITY_ARCHIVE_COLUMNS,
  CREATED_AT_SLACK_MS,
  DELIVERY_EVENT_ARCHIVE_COLUMNS,
  HISTORY_ARCHIVE_MONTHS_PER_NIGHT,
  HISTORY_ARCHIVE_PAGE_SIZE,
  HISTORY_ARCHIVE_SETTLE_DAYS,
  HISTORY_SOURCES,
  PLATFORM_SUBJECT,
  archiveHistoryPartition,
  createHistoryArchiveScheduler,
  historyArchiveKey,
  historyCsvCell,
  historyCsvLine,
  historyPartitionsDue,
  historyPeriod,
  historySourceOf,
};
export type {
  AttachedHistoryPartition,
  HistoryArchiveOptions,
  HistoryArchiveScheduler,
  HistoryPartition,
  HistorySource,
  HistoryTable,
};
