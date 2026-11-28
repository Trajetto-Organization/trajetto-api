import type { PrismaClient } from "@prisma/client";

import database from "@/../infra/database";

import {
  DELIVERY_METRIC_PREFIX,
  PENDING_DELIVERY_METRIC,
} from "./tenant-day-rules";

/** A company the rollup counts: any not being purged. */
interface RollupBusiness {
  id: string;
  /** `Business.timezone` as stored; resolveTimeZone reads it. */
  timezone: string | null;
}

interface RollupMetricKey {
  businessId: string;
  metric: string;
}

/** The first and last stored day ("YYYY-MM-DD") of a metric, null without rows. */
interface RollupCoverageRow extends RollupMetricKey {
  first: string | null;
  last: string | null;
}

/** A dirty UTC day ("YYYY-MM-DD") taken from the marks and not counted yet. */
interface RollupPendingDay {
  businessId: string;
  day: string;
}

/** Whether the company created a delivery in [from, to). */
interface RollupActivityProbe {
  businessId: string;
  from: Date;
  to: Date;
}

/** One stored day: the company's deliveries created in [from, to). */
interface RollupUnit {
  metric: string;
  day: string;
  from: Date;
  to: Date;
}

/** A company's days counted together, and its pending days settled with them. */
interface RollupGroup {
  businessId: string;
  units: RollupUnit[];
  settle: string[];
}

/** Rows of `metric` from `from` on are kept; every other `delivery@` row goes. */
interface RollupKeep {
  businessId: string;
  metric: string;
  from: string;
}

/**
 * The rollup job's reads and writes (plano-escala F4-21), on whatever client
 * it is given: the job passes databaseBatch, the maintenance pool, so the
 * counts over months of deliveries never take a request's connection.
 * Every statement here scopes by the company's key, so each lookup is a
 * range of a primary key or of delivery's (businessId, created_at) index.
 */
interface ITenantDayRollupRepository {
  /** Every company not being purged (PURGING or PURGED), by id. */
  listBusinesses(): Promise<RollupBusiness[]>;

  /**
   * Takes up to `limit` marks, oldest first, and keeps their days as the
   * company's pending days, in ONE transaction: the marks go, so the next
   * change to those days marks them again, and their days stay until
   * counted. A mark of a company that no longer exists, or is being
   * purged, is only dropped. `taken` counts the marks, `added` the pending
   * days that were not pending yet.
   */
  takeDirtyMarks(limit: number): Promise<{ taken: number; added: number }>;

  /** Up to `perBusiness` pending days of each company, by day. */
  listPending(
    businessIds: readonly string[],
    perBusiness: number,
  ): Promise<RollupPendingDay[]>;

  /** The id past every transaction in flight now (an xid8, as text). */
  inFlightHorizon(): Promise<string>;

  /** Whether every transaction in flight at `horizon` has ended. */
  settledSince(horizon: string): Promise<boolean>;

  coverage(keys: readonly RollupMetricKey[]): Promise<RollupCoverageRow[]>;

  /** The companies, by id, that created a delivery inside their probe. */
  activeBusinesses(probes: readonly RollupActivityProbe[]): Promise<string[]>;

  /**
   * Counts every unit and stores it (a zero too), and settles the groups'
   * pending days, in ONE statement: one snapshot, so a pending day is gone
   * only with the counts taken after it. A unit of a company that no longer
   * exists or is being purged is skipped. Units must be unique per
   * (company, metric, day).
   */
  store(
    groups: readonly RollupGroup[],
  ): Promise<{ stored: number; settled: number }>;

  /** Deletes the companies' `delivery@` rows that no keep covers. */
  prune(
    businessIds: readonly string[],
    keep: readonly RollupKeep[],
  ): Promise<number>;
}

/** An instant as the dashboard binds it: ISO, read as UTC whatever the session. */
function iso(instant: Date): string {
  return instant.toISOString();
}

class TenantDayRollupRepository implements ITenantDayRollupRepository {
  constructor(private readonly prisma: PrismaClient = database) {}

  async listBusinesses(): Promise<RollupBusiness[]> {
    return this.prisma.$queryRaw<RollupBusiness[]>`
      SELECT "id", "timezone"
      FROM "business"
      WHERE "purge_state" IS NULL OR "purge_state" = 'SCHEDULED'
      ORDER BY "id" COLLATE "C"
    `;
  }

  async takeDirtyMarks(
    limit: number,
  ): Promise<{ taken: number; added: number }> {
    // SKIP LOCKED: the purge deletes a company's marks in batches of its
    // own, and the job never waits for it. A mark still being written is
    // not committed, so it is not seen at all: the next run takes it.
    const [row] = await this.prisma.$queryRaw<
      Array<{ taken: number; added: number }>
    >`
      WITH "picked" AS (
        SELECT "id" FROM "tenant_day_dirty"
        ORDER BY "id"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), "taken" AS (
        DELETE FROM "tenant_day_dirty" AS d
        USING "picked" AS p
        WHERE d."id" = p."id"
        RETURNING d."businessId", d."day"
      ), "added" AS (
        INSERT INTO "tenant_day_count" ("businessId", "metric", "day", "value", "computed_at")
        SELECT DISTINCT t."businessId", ${PENDING_DELIVERY_METRIC}, t."day", 0, (now() AT TIME ZONE 'UTC')
        FROM "taken" AS t
        JOIN "business" AS b ON b."id" = t."businessId"
        WHERE b."purge_state" IS NULL OR b."purge_state" = 'SCHEDULED'
        ON CONFLICT ("businessId", "metric", "day") DO NOTHING
        RETURNING 1
      )
      SELECT
        (SELECT count(*) FROM "taken")::int AS "taken",
        (SELECT count(*) FROM "added")::int AS "added"
    `;

    return { taken: row?.taken ?? 0, added: row?.added ?? 0 };
  }

  async listPending(
    businessIds: readonly string[],
    perBusiness: number,
  ): Promise<RollupPendingDay[]> {
    if (businessIds.length === 0) return [];

    return this.prisma.$queryRaw<RollupPendingDay[]>`
      SELECT p."businessId", p."day"::text AS "day"
      FROM unnest(${[...businessIds]}::text[]) AS k("businessId")
      CROSS JOIN LATERAL (
        SELECT c."businessId", c."day"
        FROM "tenant_day_count" AS c
        WHERE c."businessId" = k."businessId"
          AND c."metric" = ${PENDING_DELIVERY_METRIC}
        ORDER BY c."day"
        LIMIT ${perBusiness}
      ) AS p
      ORDER BY p."businessId" COLLATE "C", p."day"
    `;
  }

  async inFlightHorizon(): Promise<string> {
    const [row] = await this.prisma.$queryRaw<Array<{ horizon: string }>>`
      SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS "horizon"
    `;

    return row.horizon;
  }

  async settledSince(horizon: string): Promise<boolean> {
    // The oldest transaction still running is past the horizon: every one
    // that was running when it was read has committed or rolled back.
    const [row] = await this.prisma.$queryRaw<Array<{ settled: boolean }>>`
      SELECT pg_snapshot_xmin(pg_current_snapshot()) >= ${horizon}::xid8 AS "settled"
    `;

    return row.settled;
  }

  async coverage(
    keys: readonly RollupMetricKey[],
  ): Promise<RollupCoverageRow[]> {
    if (keys.length === 0) return [];

    return this.prisma.$queryRaw<RollupCoverageRow[]>`
      SELECT
        k."businessId",
        k."metric",
        (
          SELECT min(c."day") FROM "tenant_day_count" AS c
          WHERE c."businessId" = k."businessId" AND c."metric" = k."metric"
        )::text AS "first",
        (
          SELECT max(c."day") FROM "tenant_day_count" AS c
          WHERE c."businessId" = k."businessId" AND c."metric" = k."metric"
        )::text AS "last"
      FROM unnest(
        ${keys.map((key) => key.businessId)}::text[],
        ${keys.map((key) => key.metric)}::text[]
      ) AS k("businessId", "metric")
      ORDER BY k."businessId" COLLATE "C", k."metric" COLLATE "C"
    `;
  }

  async activeBusinesses(
    probes: readonly RollupActivityProbe[],
  ): Promise<string[]> {
    if (probes.length === 0) return [];

    const rows = await this.prisma.$queryRaw<Array<{ businessId: string }>>`
      SELECT p."businessId"
      FROM unnest(
        ${probes.map((probe) => probe.businessId)}::text[],
        ${probes.map((probe) => iso(probe.from))}::text[],
        ${probes.map((probe) => iso(probe.to))}::text[]
      ) AS p("businessId", "from", "to")
      WHERE EXISTS (
        SELECT 1 FROM "delivery" AS d
        WHERE d."businessId" = p."businessId"
          AND d."created_at" >= (p."from"::timestamptz AT TIME ZONE 'UTC')
          AND d."created_at" < (p."to"::timestamptz AT TIME ZONE 'UTC')
      )
      ORDER BY p."businessId" COLLATE "C"
    `;

    return rows.map((row) => row.businessId);
  }

  async store(
    groups: readonly RollupGroup[],
  ): Promise<{ stored: number; settled: number }> {
    const units = groups.flatMap((group) =>
      group.units.map((unit) => ({ businessId: group.businessId, ...unit })),
    );
    const settle = groups.flatMap((group) =>
      group.settle.map((day) => ({ businessId: group.businessId, day })),
    );

    if (units.length === 0 && settle.length === 0) {
      return { stored: 0, settled: 0 };
    }

    // Each day is a range count over delivery's (businessId, created_at)
    // index, the same [from, to) the dashboard files a row by, so a stored
    // day equals the live count of that day by construction.
    const [row] = await this.prisma.$queryRaw<
      Array<{ stored: number; settled: number }>
    >`
      WITH "unit" AS (
        SELECT * FROM unnest(
          ${units.map((unit) => unit.businessId)}::text[],
          ${units.map((unit) => unit.metric)}::text[],
          ${units.map((unit) => unit.day)}::date[],
          ${units.map((unit) => iso(unit.from))}::text[],
          ${units.map((unit) => iso(unit.to))}::text[]
        ) AS u("businessId", "metric", "day", "from", "to")
      ), "counted" AS (
        SELECT
          u."businessId",
          u."metric",
          u."day",
          (
            SELECT count(*) FROM "delivery" AS d
            WHERE d."businessId" = u."businessId"
              AND d."created_at" >= (u."from"::timestamptz AT TIME ZONE 'UTC')
              AND d."created_at" < (u."to"::timestamptz AT TIME ZONE 'UTC')
          ) AS "value"
        FROM "unit" AS u
        JOIN "business" AS b ON b."id" = u."businessId"
        WHERE b."purge_state" IS NULL OR b."purge_state" = 'SCHEDULED'
      ), "stored" AS (
        INSERT INTO "tenant_day_count" ("businessId", "metric", "day", "value", "computed_at")
        SELECT "businessId", "metric", "day", "value", (now() AT TIME ZONE 'UTC')
        FROM "counted"
        ON CONFLICT ("businessId", "metric", "day") DO UPDATE
        SET "value" = EXCLUDED."value", "computed_at" = EXCLUDED."computed_at"
        RETURNING 1
      ), "settled" AS (
        DELETE FROM "tenant_day_count" AS p
        USING unnest(
          ${settle.map((entry) => entry.businessId)}::text[],
          ${settle.map((entry) => entry.day)}::date[]
        ) AS s("businessId", "day")
        WHERE p."businessId" = s."businessId"
          AND p."metric" = ${PENDING_DELIVERY_METRIC}
          AND p."day" = s."day"
        RETURNING 1
      )
      SELECT
        (SELECT count(*) FROM "stored")::int AS "stored",
        (SELECT count(*) FROM "settled")::int AS "settled"
    `;

    return { stored: row?.stored ?? 0, settled: row?.settled ?? 0 };
  }

  async prune(
    businessIds: readonly string[],
    keep: readonly RollupKeep[],
  ): Promise<number> {
    if (businessIds.length === 0) return 0;

    return this.prisma.$executeRaw`
      DELETE FROM "tenant_day_count" AS t
      WHERE t."businessId" = ANY(${[...businessIds]}::text[])
        AND starts_with(t."metric", ${DELIVERY_METRIC_PREFIX})
        AND NOT EXISTS (
          SELECT 1 FROM unnest(
            ${keep.map((entry) => entry.businessId)}::text[],
            ${keep.map((entry) => entry.metric)}::text[],
            ${keep.map((entry) => entry.from)}::date[]
          ) AS k("businessId", "metric", "from")
          WHERE k."businessId" = t."businessId"
            AND k."metric" = t."metric"
            AND t."day" >= k."from"
        )
    `;
  }
}

export { TenantDayRollupRepository };
export type {
  ITenantDayRollupRepository,
  RollupActivityProbe,
  RollupBusiness,
  RollupCoverageRow,
  RollupGroup,
  RollupKeep,
  RollupMetricKey,
  RollupPendingDay,
  RollupUnit,
};
