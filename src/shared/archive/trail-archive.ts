import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { PrismaClient } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { logger } from "@/shared/logging/logger";

import { ARCHIVE_PLATFORM_SUBJECT } from "./archive-settings";
import type { ArchiveStorage } from "./archive-storage";

const log = logger.child({ component: "trail-archive" });

/**
 * The GPS trail's archive (plano-escala F2-11): before the nightly
 * partition job drops a day of the trail, that day is copied to the archive
 * bucket, one gzipped CSV per company, at
 * `trail/<yyyymmdd>/<businessId>.csv.gz`, and written down in
 * archive_manifest with its row count and sha256. The DROP only goes ahead
 * when the manifest's rows add up to the partition's count
 * (archive_partition records that check); a day that does not add up stays
 * in the database, and the partition-stuck alert says so after three
 * nights. The bucket's own Expiration rule removes an object after
 * TRAIL_ARCHIVE_RETENTION_DAYS (decision D3: 30 days hot, 180 archived).
 *
 * How a day is read: one GROUP BY over the partition says which drivers of
 * which company it holds and how many rows each, then every driver's rows
 * are paged by the primary key (driverId, recorded_at) — the lean trail has
 * no index by company (F2-10), and a query per company would scan the whole
 * partition once per company, ~3.600 times a night at the reference scale.
 * Everything is read through the parent, inside the partition's range: the
 * batch login has privileges on the parent, never on a partition.
 *
 * Crash-safe by construction:
 *  - the manifest row is written PENDING, with its key, BEFORE the first
 *    byte goes up, so deleteTrailArchive always knows every key that may
 *    exist;
 *  - the key is fixed by the day and the company, and a put replaces the
 *    object whole, so a rerun after a crash rewrites the same object and
 *    never leaves a second one;
 *  - a company whose ARCHIVED row already counts what the partition holds
 *    is not uploaded again: a run cut short by its budget resumes where it
 *    stopped on the next night.
 *
 * The rows of a company that no longer exists, or whose purge started
 * (PURGING, PURGED), are not archived: the company's deletion took
 * everything else of it, and its archive goes the same way. They are written down as SKIPPED (with their count, so the sum
 * still adds up) and leave with the partition. The night's housekeeping
 * also deletes the archives of companies deleted since they were archived
 * (deleteTrailArchive), and purges the manifest rows whose objects the
 * bucket has expired.
 */

type ArchiveDatabase = Pick<
  PrismaClient,
  "$queryRawUnsafe" | "$executeRawUnsafe"
>;

/** A partitioned trail table and how its ids are typed. */
interface TrailSource {
  table: string;
  idType: "uuid" | "text";
  /**
   * The legacy trail (F2-10) has days of its own until it is dropped
   * (F2-12), and on the day of the switch both tables hold rows of the
   * same companies: its objects go under `legacy/` of the same day, so the
   * two never share a key, and the `trail/` Expiration rule covers both.
   */
  legacy: boolean;
}

const TRAIL_SOURCES: readonly TrailSource[] = [
  { table: "driver_position_v2", idType: "uuid", legacy: false },
  { table: "driver_position", idType: "text", legacy: true },
];

function trailSourceOf(table: string): TrailSource | null {
  return TRAIL_SOURCES.find((source) => source.table === table) ?? null;
}

/**
 * The CSV's columns, in this order. The company is the object's own key;
 * the legacy trail's id and arrival time are not carried (the lean trail
 * has neither, and the two tables archive alike).
 */
const TRAIL_CSV_COLUMNS = [
  "driver_id",
  "recorded_at",
  "route_id",
  "latitude",
  "longitude",
  "accuracy",
  "speed",
  "heading",
  "battery",
] as const;

/** Rows per page of a driver's day: a few hundred kilobytes of CSV. */
const TRAIL_ARCHIVE_PAGE_SIZE = 5_000;

/**
 * Manifest rows outlive their objects by this much before the purge: the
 * bucket's Expiration runs once a day and can lag, and a row deleted before
 * its object is an object deleteTrailArchive can no longer find.
 */
const MANIFEST_PURGE_SLACK_DAYS = 7;

/**
 * A company whose trail is archived: one that exists and is not being
 * purged. From PURGING on (plano-escala F3-26a) its trail is a deleted
 * company's: a day still holding its rows is SKIPPED, and its archived
 * objects go with the purge or with the housekeeping. A SCHEDULED one is
 * still archived: it can be reactivated with everything in place.
 */
function keptCompany(alias: string): string {
  return `(${alias}."purge_state" IS NULL OR ${alias}."purge_state" = 'SCHEDULED'::"BusinessPurgeState")`;
}

/** Companies whose archives one night's housekeeping deletes, at most. */
const GONE_COMPANIES_PER_RUN = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `trail/<yyyymmdd>/[legacy/]<businessId>.csv.gz`, the day in UTC. */
function trailArchiveKey(
  source: TrailSource,
  partitionStart: Date,
  businessId: string,
): string {
  const day = `${pad(partitionStart.getUTCFullYear(), 4)}${pad(
    partitionStart.getUTCMonth() + 1,
  )}${pad(partitionStart.getUTCDate())}`;

  return `trail/${day}/${source.legacy ? "legacy/" : ""}${businessId}.csv.gz`;
}

type CsvValue = string | number | Date | null | undefined;

/** A CSV cell: empty for null, quoted only when the value needs it. */
function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(value);

  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

interface TrailRow {
  driver_id: string;
  recorded_at: Date;
  route_id: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
}

function csvLine(row: TrailRow): string {
  return `${TRAIL_CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")}\n`;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** One day of the trail, `from` inclusive and `to` exclusive. */
interface TrailPartition {
  name: string;
  from: Date;
  to: Date;
}

interface CompanyDay {
  businessId: string;
  drivers: string[];
  rows: number;
}

/** Which companies and drivers the day holds, and how many rows each. */
async function companiesOf(
  db: ArchiveDatabase,
  source: TrailSource,
  partition: TrailPartition,
): Promise<CompanyDay[]> {
  const groups = await db.$queryRawUnsafe<
    Array<{ business_id: string; driver_id: string; rows: number }>
  >(
    `SELECT "businessId"::text AS business_id, "driverId"::text AS driver_id,
            count(*)::int AS rows
       FROM ${quote(source.table)}
      WHERE "recorded_at" >= $1::timestamp AND "recorded_at" < $2::timestamp
      GROUP BY 1, 2`,
    partition.from.toISOString(),
    partition.to.toISOString(),
  );

  const companies = new Map<string, CompanyDay>();

  for (const group of groups) {
    const company = companies.get(group.business_id) ?? {
      businessId: group.business_id,
      drivers: [],
      rows: 0,
    };

    company.drivers.push(group.driver_id);
    company.rows += Number(group.rows);
    companies.set(group.business_id, company);
  }

  for (const company of companies.values()) company.drivers.sort();

  return [...companies.values()].sort((a, b) =>
    a.businessId < b.businessId ? -1 : 1,
  );
}

/**
 * The company's rows of the day, as CSV text, driver by driver, each paged
 * by (driverId, recorded_at): the primary key of both trail tables (the
 * legacy one's unique), so every page is an index range.
 */
async function* companyCsv(
  db: ArchiveDatabase,
  source: TrailSource,
  partition: TrailPartition,
  company: CompanyDay,
  pageSize: number,
  counted: { rows: number },
): AsyncGenerator<string> {
  yield `${TRAIL_CSV_COLUMNS.join(",")}\n`;

  const page = (after: boolean) =>
    `SELECT "driverId"::text AS driver_id, "routeId"::text AS route_id,
            "latitude", "longitude", "accuracy", "speed", "heading",
            "battery", "recorded_at"
       FROM ${quote(source.table)}
      WHERE "driverId" = $1::${source.idType}
        AND "businessId" = $2::${source.idType}
        AND "recorded_at" >= $3::timestamp AND "recorded_at" < $4::timestamp
        ${after ? `AND "recorded_at" > $5::timestamp` : ""}
      ORDER BY "recorded_at"
      LIMIT ${pageSize}`;

  for (const driverId of company.drivers) {
    let after: Date | null = null;

    for (;;) {
      const params: string[] = [
        driverId,
        company.businessId,
        partition.from.toISOString(),
        partition.to.toISOString(),
      ];

      if (after) params.push(after.toISOString());

      const rows: TrailRow[] = await db.$queryRawUnsafe<TrailRow[]>(
        page(after !== null),
        ...params,
      );

      if (rows.length === 0) break;

      counted.rows += rows.length;
      yield rows.map(csvLine).join("");

      if (rows.length < pageSize) break;

      after = rows[rows.length - 1].recorded_at;
    }
  }
}

/**
 * Gzips `lines` into the object `key`, hashing the bytes as they go: the
 * sha256 is of the object exactly as stored, so `sha256sum` of a download
 * matches the manifest. A failure on either side (the database, the
 * bucket) stops both and rejects.
 */
async function writeGzipObject(
  storage: ArchiveStorage,
  key: string,
  lines: AsyncIterable<string>,
): Promise<{ bytes: number; sha256: string }> {
  const gzip = createGzip();
  const feeding = pipeline(Readable.from(lines), gzip);

  // Observed below; until then a rejection must not go unhandled.
  feeding.catch(() => undefined);

  const digest = createHash("sha256");
  let bytes = 0;

  async function* hashed(): AsyncGenerator<Buffer> {
    for await (const chunk of gzip as AsyncIterable<Buffer>) {
      digest.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  }

  await storage.put(key, hashed());
  await feeding;

  return { bytes, sha256: digest.digest("hex") };
}

interface ManifestRow {
  business_id: string;
  status: "PENDING" | "ARCHIVED" | "SKIPPED";
  row_count: number | null;
  object_key: string;
}

/** What became of one partition. */
type ArchiveVerdict =
  | {
      verified: true;
      rows: number;
      objects: number;
      skippedRows: number;
      written: number;
    }
  | {
      verified: false;
      reason: "budget" | "mismatch";
      rows: number;
      manifestRows: number;
      pending: number;
      written: number;
    };

interface TrailArchiveOptions {
  db: ArchiveDatabase;
  storage: ArchiveStorage;
  /** Epoch ms past which no new company is started (the run's budget). */
  deadline: number;
  now?: () => number;
  pageSize?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Archives what is missing of one day and checks the whole: true only when
 * no row is PENDING and the manifest adds up to a count taken AFTER the
 * uploads. Throws when the database or the bucket fails; the partition is
 * then simply not dropped, and the next night resumes.
 */
async function archiveTrailPartition(
  source: TrailSource,
  partition: TrailPartition,
  options: TrailArchiveOptions,
): Promise<ArchiveVerdict> {
  const { db, storage, deadline } = options;
  const now = options.now ?? Date.now;
  const pageSize = options.pageSize ?? TRAIL_ARCHIVE_PAGE_SIZE;

  const companies = await companiesOf(db, source, partition);
  const ids = companies.map((company) => company.businessId);

  const existing = new Set(
    ids.length === 0
      ? []
      : (
          await db.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT b."id" FROM "business" b
              WHERE b."id" = ANY($1::text[]) AND ${keptCompany("b")}`,
            ids,
          )
        ).map((row) => row.id),
  );

  const manifest = new Map(
    (
      await db.$queryRawUnsafe<ManifestRow[]>(
        `SELECT "businessId" AS business_id, "status"::text AS status,
                "row_count", "object_key"
           FROM "archive_manifest"
          WHERE "partition_name" = $1`,
        partition.name,
      )
    ).map((row) => [row.business_id, row]),
  );

  let written = 0;
  let outOfTime = false;

  for (const company of companies) {
    const key = trailArchiveKey(source, partition.from, company.businessId);
    const recorded = manifest.get(company.businessId);

    if (!existing.has(company.businessId)) {
      if (
        recorded?.status === "SKIPPED" &&
        recorded.row_count === company.rows
      ) {
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
        company.businessId,
        key,
        company.rows,
        iso(now()),
      );

      continue;
    }

    if (
      recorded?.status === "ARCHIVED" &&
      recorded.row_count === company.rows
    ) {
      continue;
    }

    if (now() >= deadline) {
      outOfTime = true;
      break;
    }

    // The key is known before the first byte goes up (see the top).
    await db.$executeRawUnsafe(
      `INSERT INTO "archive_manifest"
         ("id", "source_table", "partition_name", "businessId", "object_key",
          "status", "created_at")
       VALUES ($1, $2, $3, $4, $5, 'PENDING'::"ArchiveObjectStatus", $6::timestamp)
       ON CONFLICT ("partition_name", "businessId") DO NOTHING`,
      uuidV7(),
      source.table,
      partition.name,
      company.businessId,
      key,
      iso(now()),
    );

    const counted = { rows: 0 };
    const object = await writeGzipObject(
      storage,
      key,
      companyCsv(db, source, partition, company, pageSize, counted),
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
      company.businessId,
      key,
      counted.rows,
      object.bytes,
      object.sha256,
      iso(now()),
    );

    written += 1;
  }

  // Counted after the uploads: a row that landed in between makes the sum
  // fall short, and the day waits for the next night instead of losing it.
  const [actual] = await db.$queryRawUnsafe<Array<{ rows: number }>>(
    `SELECT count(*)::bigint AS rows
       FROM ${quote(source.table)}
      WHERE "recorded_at" >= $1::timestamp AND "recorded_at" < $2::timestamp`,
    partition.from.toISOString(),
    partition.to.toISOString(),
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

/**
 * Deletes every archived object of a company and its manifest rows: the
 * tenant's exit (the nightly housekeeping calls it for every company that
 * no longer exists) and a LGPD request about a company's trail. Only the
 * rows whose objects are gone are deleted, so a bucket that failed half-way
 * leaves the rest for the next call. Answers how many keys it deleted.
 */
async function deleteTrailArchive(
  businessId: string,
  options: { db: ArchiveDatabase; storage: ArchiveStorage },
): Promise<number> {
  const rows = await options.db.$queryRawUnsafe<Array<{ object_key: string }>>(
    `SELECT "object_key" FROM "archive_manifest" WHERE "businessId" = $1`,
    businessId,
  );
  const keys = [...new Set(rows.map((row) => row.object_key))];

  await options.storage.deleteMany(keys);

  if (keys.length > 0) {
    await options.db.$executeRawUnsafe(
      `DELETE FROM "archive_manifest"
        WHERE "businessId" = $1 AND "object_key" = ANY($2::text[])`,
      businessId,
      keys,
    );
  }

  return keys.length;
}

/**
 * What the nightly partition job asks of the archive (plano-escala F2-11).
 * Never throws: a failure is logged and answered as "not archived", which
 * keeps the partition where it is.
 */
interface TrailArchiveGate {
  /**
   * Whether the day may be dropped: true at once for a table that is not
   * a trail; for a trail, after archiving what is missing and checking the
   * sum.
   */
  ensureArchived(table: string, partition: TrailPartition): Promise<boolean>;

  /**
   * Whether a day detached on an earlier night and not dropped may be:
   * only a verified one, since it can no longer be read through the parent.
   */
  mayDropDetached(table: string, name: string): Promise<boolean>;

  /** The archives of companies that left, and the manifest's purge. */
  housekeeping(): Promise<void>;
}

/**
 * The PARTITION_ARCHIVE jobs (plano-escala F3-28), as the gate sees them:
 * with them, the night only enqueues an expired day and keeps it, and the
 * job archives it off the cron (src/shared/jobs/partition-archive.ts).
 */
interface TrailArchiveJobs {
  /** Whether a job of the partition is still live (pending or running). */
  running(name: string): Promise<boolean>;

  /**
   * Enqueues the partition's archive: one live job per partition. The
   * history's DROP (F5-17) asks for every object written before
   * `rewriteBefore` to be written again.
   */
  enqueue(
    table: string,
    partition: TrailPartition,
    options?: { rewriteBefore?: Date },
  ): Promise<void>;
}

interface TrailArchiveGateOptions {
  db: ArchiveDatabase;
  /** Null: enabled without the bucket or the token (`missing` says which). */
  storage: ArchiveStorage | null;

  /**
   * The jobs that archive a day (F3-28). Absent: the gate archives inline,
   * inside the night's budget, as it did before the jobs.
   */
  jobs?: TrailArchiveJobs;
  missing?: readonly string[];
  /** Epoch ms past which no new company is started. */
  deadline: number;
  retentionDays: number;
  now?: () => number;
  pageSize?: number;
}

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();

function createTrailArchiveGate(
  options: TrailArchiveGateOptions,
): TrailArchiveGate {
  const now = options.now ?? Date.now;
  const { db, storage } = options;

  // After the bucket failed once, the rest of the run holds its days
  // without trying: a bucket away at 04:10 does not come back a second
  // later, and each try would wait for the client's timeouts.
  let storageDown = false;
  let warnedUnconfigured = false;

  const verified = async (name: string) =>
    (
      await db.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM "archive_partition" WHERE "partition_name" = $1) AS present`,
        name,
      )
    )[0]?.present === true;

  return {
    async ensureArchived(table, partition) {
      const source = trailSourceOf(table);

      if (!source) return true;

      if (!storage) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          log.warn(
            { table, missing: options.missing ?? [] },
            "trail archive enabled but not configured: expired days are kept",
          );
        }

        return false;
      }

      if (storageDown) return false;

      // F3-28: the day goes only once its manifest adds up and no job of it
      // is still running; until then it is handed to the job and kept.
      if (options.jobs) {
        try {
          if (
            (await verified(partition.name)) &&
            !(await options.jobs.running(partition.name))
          ) {
            return true;
          }

          await options.jobs.enqueue(table, partition);
          log.info(
            { table, partition: partition.name },
            "trail day handed to its archive job; kept until its manifest adds up",
          );
        } catch (error) {
          log.warn(
            { table, partition: partition.name, error: errorMessage(error) },
            "trail archive job could not be enqueued: the day is kept",
          );
        }

        return false;
      }

      try {
        const verdict = await archiveTrailPartition(source, partition, {
          db,
          storage,
          deadline: options.deadline,
          now,
          pageSize: options.pageSize,
        });

        if (verdict.verified) {
          log.info(
            { table, partition: partition.name, ...verdict },
            "trail partition archived",
          );

          return true;
        }

        const { verified: _verified, ...facts } = verdict;

        log.warn(
          { table, partition: partition.name, ...facts },
          verdict.reason === "budget"
            ? "trail archive out of time: the day waits for the next night"
            : "trail archive does not add up: the day is kept",
        );

        return false;
      } catch (error) {
        storageDown = true;
        log.warn(
          { table, partition: partition.name, error: errorMessage(error) },
          "trail archive failed: the day is kept",
        );

        return false;
      }
    },

    async mayDropDetached(table, name) {
      if (!trailSourceOf(table)) return true;

      try {
        if (await verified(name)) return true;
      } catch (error) {
        log.warn(
          { table, partition: name, error: errorMessage(error) },
          "trail archive check failed: the detached day is kept",
        );

        return false;
      }

      log.warn(
        { table, partition: name },
        "detached trail day without a verified archive is kept",
      );

      return false;
    },

    async housekeeping() {
      if (!storage) return;

      try {
        const gone = await db.$queryRawUnsafe<Array<{ business_id: string }>>(
          // The history's platform rows (F5-16) are no company's: never
          // taken for a company that left.
          `SELECT DISTINCT m."businessId" AS business_id
             FROM "archive_manifest" m
            WHERE m."status" <> 'SKIPPED'::"ArchiveObjectStatus"
              AND m."businessId" <> '${ARCHIVE_PLATFORM_SUBJECT}'
              AND NOT EXISTS (
                SELECT 1 FROM "business" b
                 WHERE b."id" = m."businessId" AND ${keptCompany("b")}
              )
            LIMIT ${GONE_COMPANIES_PER_RUN}`,
        );

        for (const { business_id: businessId } of gone) {
          const deleted = await deleteTrailArchive(businessId, { db, storage });

          log.info(
            { businessId, objects: deleted },
            "trail archive of a deleted company removed",
          );
        }

        const cutoff = iso(
          now() - (options.retentionDays + MANIFEST_PURGE_SLACK_DAYS) * DAY_MS,
        );
        // Only the trail's rows: the bucket expires `trail/` at the
        // retention, while the history's manifest (F5-16) is what proves a
        // month before its DROP and outlives it for the legal term.
        const trailTables = TRAIL_SOURCES.map((source) => source.table);
        const purgedObjects = await db.$executeRawUnsafe(
          `DELETE FROM "archive_manifest"
            WHERE coalesce("archived_at", "created_at") < $1::timestamp
              AND "source_table" = ANY($2::text[])`,
          cutoff,
          trailTables,
        );
        const purgedDays = await db.$executeRawUnsafe(
          `DELETE FROM "archive_partition"
            WHERE "verified_at" < $1::timestamp
              AND "source_table" = ANY($2::text[])`,
          cutoff,
          trailTables,
        );

        if (purgedObjects > 0 || purgedDays > 0) {
          log.info(
            { objects: purgedObjects, days: purgedDays },
            "trail archive manifest purged",
          );
        }
      } catch (error) {
        log.warn(
          { error: errorMessage(error) },
          "trail archive housekeeping failed; it runs again next night",
        );
      }
    },
  };
}

/**
 * The drivers of a company removed and anonymized (plano-escala F3-27,
 * decision D49) whose days may still be in the archive: the archived
 * objects are not rewritten per request, so whatever restores a day of the
 * archive (a legal request, archive-restore of F5-16) leaves these drivers'
 * rows out, through withoutRedactedDrivers.
 */
async function redactedTrailDrivers(
  db: ArchiveDatabase,
  businessId: string,
): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<Array<{ driver_id: string }>>(
    `SELECT "driverId" AS driver_id FROM "trail_archive_redaction"
      WHERE "businessId" = $1`,
    businessId,
  );

  return new Set(rows.map((row) => row.driver_id));
}

/**
 * A restored day's CSV lines (the header first, TRAIL_CSV_COLUMNS) without
 * the lines of the redacted drivers. The driver id is the first column and
 * a uuid, never quoted.
 */
function withoutRedactedDrivers(
  lines: readonly string[],
  redacted: ReadonlySet<string>,
): string[] {
  const [header, ...rows] = lines;

  if (header === undefined) return [];

  return [
    header,
    ...rows.filter((line) => !redacted.has(line.split(",", 1)[0])),
  ];
}

export {
  GONE_COMPANIES_PER_RUN,
  MANIFEST_PURGE_SLACK_DAYS,
  TRAIL_ARCHIVE_PAGE_SIZE,
  TRAIL_CSV_COLUMNS,
  TRAIL_SOURCES,
  archiveTrailPartition,
  createTrailArchiveGate,
  csvCell,
  deleteTrailArchive,
  redactedTrailDrivers,
  trailArchiveKey,
  trailSourceOf,
  withoutRedactedDrivers,
  writeGzipObject,
};
export type {
  ArchiveDatabase,
  ArchiveVerdict,
  TrailArchiveGate,
  TrailArchiveJobs,
  TrailArchiveGateOptions,
  TrailPartition,
  TrailSource,
};
