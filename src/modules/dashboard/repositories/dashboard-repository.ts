import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import {
  DashboardEntity,
  DeliveriesFromRollup,
  DeliveryCountSource,
  DeliveryWindow,
  VehicleStatusCountResult,
  MaintenanceStatsParams,
  MaintenanceStatsResult,
  VehicleTypeCountResult,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  PeriodGranularity,
  PeriodCountBucket,
  PeriodCostBucket,
  EntityTotal,
} from "../dtos/dashboard-dto";

import { IDashboardRepository } from "./IDashboard-repository";
import { deliveryPieces } from "./delivery-pieces";
import { DUE_SOON_DAYS } from "./maintenance-standing";
import { periodBuckets } from "./period-buckets";

import { businessDateKey } from "@/shared/time/business-day";

import {
  PENDING_DELIVERY_METRIC,
  deliveryMetric,
} from "@/shared/rollup/tenant-day-rules";

/**
 * A UTC timestamp column compared with an instant, whatever the session zone.
 * The instant goes as an ISO string: Prisma 7's pg driver sends a Date as a
 * naive "YYYY-MM-DD HH:MM:SS" in UTC, which `::timestamptz` would read in the
 * session's TimeZone (Prisma 6 bound it as a timestamptz itself).
 */
function utc(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * The civil day or month a row was created on, in the company's zone.
 *
 * `created_at` is `timestamp WITHOUT time zone` holding a UTC instant, so it
 * is read as UTC first and then moved to the company's wall clock before it
 * is truncated. A plain `date_trunc` files everything created after 21:00 in
 * São Paulo under the next day; the process zone (the old basis) is UTC in
 * the container and says nothing about a carrier in Manaus.
 */
function createdBucket(
  granularity: PeriodGranularity,
  timeZone: string,
): Prisma.Sql {
  const unit = granularity === "day" ? "day" : "month";
  const format = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";

  return Prisma.sql`to_char(
    date_trunc(${unit}, ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}),
    ${format}
  )`;
}

/** [from, to) on `created_at`. */
function createdWithin(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`"created_at" >= ${utc(from)} AND "created_at" < ${utc(to)}`;
}

class DashboardRepository implements IDashboardRepository {
  constructor(private prisma = database) {}

  /**
   * The table and the extra predicate behind each entity name.
   *
   * A map and not a switch, because this is used to build raw SQL and a switch
   * that fell through would build a query against whatever the last case left
   * in the variable. Every table name here is a literal in this file: nothing
   * from a request ever reaches the string.
   */
  private static readonly MONTHLY_SOURCES: Record<
    DashboardEntity,
    { table: string; extra?: Prisma.Sql }
  > = {
    vehicle: { table: "vehicle" },
    driver: { table: "driver" },
    business: { table: "business" },
    branch: { table: "branch" },
    part: { table: "part" },
    supplier: { table: "supplier" },
    "service-order": { table: "service_order" },
    user: { table: "user", extra: Prisma.sql`AND "role" <> 'MASTER'` },
    fine: { table: "fine" },

    // Both carry `businessId` and `created_at` directly, so they scope and
    // group exactly like the rest. `delivery_occurrence` deliberately does
    // not appear: it reaches its tenant through the delivery, and a join here
    // would make one of the union's arms cost an order of magnitude more than
    // the others on the busiest screen in the product.
    delivery: { table: "delivery" },
    route: { table: "route" },
  };

  /**
   * One arm of the union: an entity's rows of the window, per bucket.
   * `label` names the arm's rows (the entity, unless the caller tells two
   * arms of the same entity apart).
   */
  private static countArm(
    entity: DashboardEntity,
    params: {
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
    label: string = entity,
  ): Prisma.Sql {
    const source = DashboardRepository.MONTHLY_SOURCES[entity];

    // `business` has no businessId of its own — it IS the tenant — so
    // scoping it by one would count zero and quietly blank the card.
    const tenant =
      businessId && entity !== "business"
        ? Prisma.sql`AND "businessId" = ${businessId}`
        : Prisma.empty;

    // The buckets' boundaries come from the app (period-buckets.ts), so no
    // row is converted to the company's zone. The table is read ONCE over the
    // whole window and width_bucket files each row by a binary search of the
    // boundaries. A range count per bucket (LATERAL) was tried first: fine
    // with the tenant's (businessId, created_at) index, but a MASTER view has
    // no tenant and no table has a created_at-only index, so every bucket
    // became its own full scan, 30 per table for the 30-day trends.
    const buckets = periodBuckets(
      params.from,
      params.to,
      params.granularity,
      params.timeZone,
    );

    if (buckets.length === 0) {
      return Prisma.sql`SELECT NULL::text AS entity, NULL::text AS period, 0::bigint AS count WHERE FALSE`;
    }

    const periods = Prisma.join(
      buckets.map((bucket) => Prisma.sql`${bucket.period}::text`),
    );

    // Contiguous buckets: every start, then the last end. width_bucket gives
    // 1..n for a row inside [first start, last end), the WHERE keeps only those.
    const thresholds = Prisma.join([
      ...buckets.map((bucket) => utc(bucket.start)),
      utc(buckets[buckets.length - 1].end),
    ]);

    return Prisma.sql`
      SELECT
        ${label}::text AS entity,
        (ARRAY[${periods}]::text[])[width_bucket("created_at", ARRAY[${thresholds}]::timestamp[])] AS period,
        count(*)::bigint AS count
      FROM ${Prisma.raw(`"public"."${source.table}"`)}
      WHERE ${createdWithin(buckets[0].start, buckets[buckets.length - 1].end)}
        ${tenant}
        ${source.extra ?? Prisma.empty}
      GROUP BY 2
    `;
  }

  /**
   * The deliveries of the window, per bucket, from the closed days the
   * rollup job stored (plano-escala F4-22, decision D52): the same rows the
   * live arm returns, with the same labels, and only buckets with deliveries.
   *
   * The window is cut into the company's civil days (delivery-pieces.ts).
   * A day is read from its stored row in tenant_day_count only when the row
   * is there and can be trusted: a whole day already over, of a company not
   * being purged (the job skips those and only drops their marks), with no
   * mark in tenant_day_dirty and no pending day of the job touching it. A
   * mark holds the UTC day of the changed row's created_at, so it touches
   * the civil days that overlap that UTC day. Every other day (today, a
   * clipped one, one not stored yet, one changed since it was counted) is
   * counted live on delivery's (businessId, created_at) index, in the same
   * statement. So the answer is the live count of the same snapshot: the
   * protocol of the marks (tenant-day-rollup.ts) makes a stored row with no
   * mark the count of its day.
   *
   * A MASTER (no businessId) reads every company on the platform's calendar
   * and adds them up, each company's untrusted days counted live by its own
   * index range; the deliveries of a company being purged are all live.
   */
  private static rollupArm(
    label: string,
    params: {
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
      now: Date;
    },
    businessId?: string,
  ): Prisma.Sql {
    const pieces = deliveryPieces(params);

    if (pieces.length === 0) {
      return Prisma.sql`SELECT NULL::text AS entity, NULL::text AS period, 0::bigint AS count WHERE FALSE`;
    }

    const rows = Prisma.join(
      pieces.map(
        (piece, index) =>
          Prisma.sql`(${index}::int, ${piece.period}::text, ${utc(piece.from)}, ${utc(piece.to)}, ${piece.day}::date)`,
      ),
    );

    // The UTC days a mark touching the window can hold, both ends included:
    // the trigger marks the UTC day of created_at (migration
    // 20261119130100), so this calendar is UTC on purpose, not the company's.
    const firstUtcDay = businessDateKey(pieces[0].from, "UTC");
    const lastUtcDay = businessDateKey(pieces[pieces.length - 1].to, "UTC");

    const company = businessId
      ? Prisma.sql`WHERE "id" = ${businessId}`
      : Prisma.empty;
    const markedCompany = businessId
      ? Prisma.sql`AND "businessId" = ${businessId}`
      : Prisma.empty;

    // Parenthesised, so the arm can carry its own WITH inside the union.
    return Prisma.sql`(
      WITH "piece" ("idx", "period", "f", "t", "day") AS (
        VALUES ${rows}
      ), "scope" AS (
        SELECT "id", ("purge_state" IS NULL OR "purge_state" = 'SCHEDULED') AS "counted"
        FROM "public"."business"
        ${company}
      ), "touched" AS (
        SELECT DISTINCT m."businessId", p."idx"
        FROM (
          SELECT "businessId", "day" FROM "public"."tenant_day_dirty"
          WHERE "day" BETWEEN ${firstUtcDay}::date AND ${lastUtcDay}::date
            ${markedCompany}
          UNION ALL
          SELECT "businessId", "day" FROM "public"."tenant_day_count"
          WHERE "metric" = ${PENDING_DELIVERY_METRIC}
            AND "day" BETWEEN ${firstUtcDay}::date AND ${lastUtcDay}::date
            ${markedCompany}
        ) AS m
        JOIN "piece" AS p
          ON p."day" IS NOT NULL
          AND m."day"::timestamp < p."t"
          AND m."day"::timestamp + interval '1 day' > p."f"
      ), "cell" AS (
        SELECT p."period", s."id", p."f", p."t",
          CASE WHEN s."counted" AND tc."businessId" IS NULL THEN st."value" END AS "stored"
        FROM "piece" AS p
        CROSS JOIN "scope" AS s
        LEFT JOIN "public"."tenant_day_count" AS st
          ON st."businessId" = s."id"
          AND st."metric" = ${deliveryMetric(params.timeZone)}
          AND st."day" = p."day"
        LEFT JOIN "touched" AS tc
          ON tc."businessId" = s."id" AND tc."idx" = p."idx"
      ), "summed" AS (
        SELECT c."period", sum(COALESCE(
          c."stored",
          (
            SELECT count(*) FROM "public"."delivery" AS d
            WHERE d."businessId" = c."id"
              AND d."created_at" >= c."f"
              AND d."created_at" < c."t"
          )
        ))::bigint AS "count"
        FROM "cell" AS c
        GROUP BY c."period"
      )
      SELECT ${label}::text AS entity, "period", "count"
      FROM "summed"
      WHERE "count" > 0
    )`;
  }

  /**
   * Every entity, every month, in ONE round trip.
   *
   * The first attempt at fixing the dashboard replaced 72 sequential counts
   * with nine grouped ones — issued in parallel. Total queries fell by a
   * factor of eight and the p95 of the whole API got FIFTEEN TIMES worse: one
   * page view now grabbed nine connections at once, and at a handful of page
   * views a second that is the entire pool, with every other request in the
   * product queueing behind a chart.
   *
   * So the nine become one, stitched with UNION ALL. Same grouping, same
   * numbers, one connection, one round trip.
   */
  async countManyByMonth(
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      timeZone: string;
      deliveriesFromRollup?: DeliveriesFromRollup;
    },
    businessId?: string,
  ): Promise<Record<string, MonthlyCountBucket[]>> {
    const byPeriod = await this.countManyByPeriod(
      { ...params, granularity: "month" },
      businessId,
    );

    return Object.fromEntries(
      Object.entries(byPeriod).map(([entity, buckets]) => [
        entity,
        buckets.map((bucket) => ({
          month: bucket.period,
          count: bucket.count,
        })),
      ]),
    );
  }

  /**
   * The catalogues as stocks, in ONE round trip (the same UNION ALL as the
   * monthly counts, for the same reason: one connection per page view).
   * `total` counts every row; `before`, those created before the cut.
   */
  async countManyTotals(
    params: { entities: DashboardEntity[]; before: Date },
    businessId?: string,
  ): Promise<Record<string, EntityTotal>> {
    const result: Record<string, EntityTotal> = {};

    const wanted = params.entities.filter(
      (entity) => DashboardRepository.MONTHLY_SOURCES[entity],
    );

    for (const entity of params.entities)
      result[entity] = { total: 0, before: 0 };

    if (wanted.length === 0) return result;

    const parts = wanted.map((entity) => {
      const source = DashboardRepository.MONTHLY_SOURCES[entity];
      const tenant =
        businessId && entity !== "business"
          ? Prisma.sql`AND "businessId" = ${businessId}`
          : Prisma.empty;

      return Prisma.sql`
        SELECT
          ${entity} AS entity,
          count(*)::bigint AS total,
          count(*) FILTER (WHERE "created_at" < ${utc(params.before)})::bigint AS before
        FROM ${Prisma.raw(`"public"."${source.table}"`)}
        WHERE TRUE
          ${tenant}
          ${source.extra ?? Prisma.empty}
      `;
    });

    const rows = await this.prisma.$queryRaw<
      Array<{ entity: string; total: bigint; before: bigint }>
    >(Prisma.join(parts, " UNION ALL "));

    for (const row of rows) {
      result[row.entity] = {
        total: Number(row.total),
        before: Number(row.before),
      };
    }

    return result;
  }

  /**
   * The same union, cut by day or by month.
   *
   * `countManyByMonth` answers the overview, which always wants months. The
   * trends endpoint wants days for a seven- or thirty-day window, and it
   * used to get them by asking one count per bucket per entity: thirty days
   * times nine entities is 270 round trips, plus thirty more for the costs,
   * to draw ONE chart. Every one of them held a connection.
   */
  async countManyByPeriod(
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
      deliveriesFromRollup?: DeliveriesFromRollup;
    },
    businessId?: string,
  ): Promise<Record<string, PeriodCountBucket[]>> {
    const result: Record<string, PeriodCountBucket[]> = {};

    // An unknown name answers empty instead of failing the whole page: this
    // serves the screen every login opens.
    const wanted = params.entities.filter(
      (entity) => DashboardRepository.MONTHLY_SOURCES[entity],
    );

    for (const entity of params.entities) result[entity] = [];

    if (wanted.length === 0) return result;

    // The rollup's arm stays inside the same statement: one round trip and
    // one connection per view, as before (F4-22).
    const rollup = params.deliveriesFromRollup;
    const parts = wanted.map((entity) =>
      entity === "delivery" && rollup
        ? DashboardRepository.rollupArm(
            entity,
            { ...params, now: rollup.now },
            businessId,
          )
        : DashboardRepository.countArm(entity, params, businessId),
    );

    const rows = await this.prisma.$queryRaw<
      Array<{ entity: string; period: string; count: bigint }>
    >(Prisma.join(parts, " UNION ALL "));

    for (const row of rows) {
      (result[row.entity] ??= []).push({
        period: row.period,
        count: Number(row.count),
      });
    }

    return result;
  }

  /**
   * Each window's deliveries from each source asked, as arms of ONE union:
   * one statement, one snapshot. The live arm is the dashboard's own
   * (countArm); the rollup's is the arm countManyByPeriod uses when
   * DASHBOARD_ROLLUP_MODE=on. Their labels carry the window and the source.
   */
  async countDeliveryWindows(
    params: {
      windows: readonly DeliveryWindow[];
      timeZone: string;
      now: Date;
      sources: readonly DeliveryCountSource[];
    },
    businessId?: string,
  ): Promise<Array<Partial<Record<DeliveryCountSource, PeriodCountBucket[]>>>> {
    const result = params.windows.map(() => {
      const entry: Partial<Record<DeliveryCountSource, PeriodCountBucket[]>> =
        {};

      for (const source of params.sources) entry[source] = [];

      return entry;
    });

    if (params.windows.length === 0 || params.sources.length === 0) {
      return result;
    }

    const parts = params.windows.flatMap((window, index) =>
      params.sources.map((source) => {
        const label = `${index}:${source}`;
        const arm = { ...window, timeZone: params.timeZone };

        return source === "rollup"
          ? DashboardRepository.rollupArm(
              label,
              { ...arm, now: params.now },
              businessId,
            )
          : DashboardRepository.countArm("delivery", arm, businessId, label);
      }),
    );

    const rows = await this.prisma.$queryRaw<
      Array<{ entity: string; period: string; count: bigint }>
    >(Prisma.join(parts, " UNION ALL "));

    for (const row of rows) {
      const [index, source] = row.entity.split(":") as [
        string,
        DeliveryCountSource,
      ];

      result[Number(index)]?.[source]?.push({
        period: row.period,
        count: Number(row.count),
      });
    }

    return result;
  }

  /**
   * Maintenance spend per day or per month, summed in the database.
   *
   * Same story as the counts: the trends endpoint asked for one day at a
   * time, and each of those answers pulled every service order row of that
   * day back to add two numbers here.
   */
  async getCostsByPeriod(
    params: {
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
  ): Promise<PeriodCostBucket[]> {
    const tenant = businessId
      ? Prisma.sql`AND "businessId" = ${businessId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ period: string; internal: string; external: string }>
    >(Prisma.sql`
      SELECT
        ${createdBucket(params.granularity, params.timeZone)} AS period,

        -- Where the work was done (MaintenanceType), not its nature: the keys
        -- were "preventive/corrective" while the column never said that.
        COALESCE(
          SUM("total_amount") FILTER (WHERE "maintenance_type" = 'INTERNAL'),
          0
        )::text AS internal,

        COALESCE(
          SUM("total_amount") FILTER (WHERE "maintenance_type" = 'EXTERNAL'),
          0
        )::text AS external
      FROM "public"."service_order"
      WHERE ${createdWithin(params.from, params.to)}
        ${tenant}
      GROUP BY 1
    `);

    return rows.map((row) => ({
      period: row.period,
      internal: Number(row.internal),
      external: Number(row.external),
    }));
  }

  async countByMonth(
    params: CountByMonthParams,
    businessId?: string,
  ): Promise<MonthlyCountBucket[]> {
    if (!DashboardRepository.MONTHLY_SOURCES[params.entity]) {
      throw new Error("Entidade inválida");
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ entity: string; period: string; count: bigint }>
    >(
      DashboardRepository.countArm(
        params.entity,
        { ...params, granularity: "month" },
        businessId,
      ),
    );

    return rows.map((row) => ({
      month: row.period,
      count: Number(row.count),
    }));
  }

  async countVehiclesByStatus(
    businessId?: string,
  ): Promise<VehicleStatusCountResult> {
    const whereClause: any = {};

    if (businessId) {
      whereClause.businessId = businessId;
    }

    // One grouped count instead of four parallel ones: four connections for
    // four numbers is how the dashboard starved the pool before (see
    // countManyByMonth).
    const grouped = await this.prisma.vehicle.groupBy({
      by: ["status"],
      where: whereClause,
      _count: { _all: true },
    });

    const counts = { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 };

    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    return counts;
  }

  /**
   * The maintenance card (Atrasada / A vencer / Em dia) in ONE aggregate, on
   * the company's calendar. Same rule as maintenance-standing.ts, which the
   * twin runs; tests/E2E/dashboard-maintenance-stats holds them together.
   *
   * It used to pull every vehicle back and compare `setMonth` on the
   * server's calendar with the server's clock, so a vehicle due today was
   * late once its hour had passed and one due tomorrow at 21:00 in São Paulo.
   * Now both sides are civil days: the due day is the last maintenance's day
   * plus the interval (Postgres clamps 31/08 + 1 month to 30/09), and it is
   * compared with the company's today, which the caller passes.
   *
   * The day of the last maintenance: `timestamp` holding an instant, read in
   * the company's zone; exactly 00:00 UTC is a "YYYY-MM-DD" the API parsed,
   * read as that UTC day (no Brazilian midnight falls there).
   */
  async getMaintenanceStats(
    params: MaintenanceStatsParams,
    businessId?: string,
  ): Promise<MaintenanceStatsResult> {
    const tenant = businessId
      ? Prisma.sql`AND "businessId" = ${businessId}`
      : Prisma.empty;

    const today = Prisma.sql`${params.today}::date`;
    const horizon = Prisma.sql`(${params.today}::date + ${DUE_SOON_DAYS}::int)`;

    const [row] = await this.prisma.$queryRaw<
      Array<{
        pending: number;
        recent: number;
        overdue: number;
        unrecorded: number;
      }>
    >(Prisma.sql`
      WITH standing AS (
        SELECT
          "last_maintenance_date" IS NULL AS unrecorded,

          -- A missing last mileage counts from zero, as it always has.
          "current_mileage" >= COALESCE("last_maintenance_mileage", 0) + "maintenance_interval_km" AS km_due,

          (
            CASE
              WHEN "last_maintenance_date"::time = time '00:00'
                THEN "last_maintenance_date"::date
              ELSE (("last_maintenance_date" AT TIME ZONE 'UTC') AT TIME ZONE ${params.timeZone})::date
            END
            + make_interval(months => "maintenance_interval_months")
          )::date AS due_day
        FROM "public"."vehicle"
        WHERE TRUE ${tenant}
      )
      SELECT
        count(*) FILTER (
          WHERE NOT unrecorded AND (km_due OR due_day < ${today})
        )::int AS overdue,
        count(*) FILTER (
          WHERE unrecorded OR (NOT km_due AND due_day >= ${today} AND due_day <= ${horizon})
        )::int AS pending,
        count(*) FILTER (
          WHERE NOT unrecorded AND NOT km_due AND due_day > ${horizon}
        )::int AS recent,
        -- Inside "pending" above: how many of those only lack the record.
        count(*) FILTER (WHERE unrecorded)::int AS unrecorded
      FROM standing
    `);

    return {
      pending: row?.pending ?? 0,
      recent: row?.recent ?? 0,
      overdue: row?.overdue ?? 0,
      unrecorded: row?.unrecorded ?? 0,
    };
  }

  /**
   * Six months of spend, summed per month and per kind, in one query.
   *
   * The per-month version fetched every service order row of the month and
   * added them up in JavaScript. At a carrier with a real workshop that is
   * thousands of rows crossing the wire, six times, to produce twelve numbers
   * — and the sum of a `Decimal` is a job the database does exactly and
   * JavaScript does approximately.
   */
  async getCostsByMonth(
    params: { from: Date; to: Date; timeZone: string },
    businessId?: string,
  ): Promise<MonthlyCostBucket[]> {
    const buckets = await this.getCostsByPeriod(
      { ...params, granularity: "month" },
      businessId,
    );

    return buckets.map((bucket) => ({
      month: bucket.period,
      internal: bucket.internal,
      external: bucket.external,
    }));
  }

  async countVehiclesByType(
    businessId?: string,
  ): Promise<VehicleTypeCountResult> {
    // Grouped in the database rather than by pulling every vehicle back to
    // count them here: a fleet is the one table that is large by definition,
    // and the answer is a handful of rows either way.
    const grouped = await this.prisma.vehicle.groupBy({
      by: ["vehicleTypeId"],
      where: businessId ? { businessId } : {},
      _count: { _all: true },
    });

    const typeIds = grouped
      .map((entry) => entry.vehicleTypeId)
      .filter((id): id is string => Boolean(id));

    const types = typeIds.length
      ? await this.prisma.vehicleType.findMany({
          where: { id: { in: typeIds } },
          select: { id: true, description: true },
        })
      : [];

    const names = new Map(types.map((type) => [type.id, type.description]));

    const typeCounts: Record<string, number> = {};

    for (const entry of grouped) {
      const description =
        (entry.vehicleTypeId && names.get(entry.vehicleTypeId)) || "Outros";

      typeCounts[description] =
        (typeCounts[description] || 0) + entry._count._all;
    }

    const data = Object.entries(typeCounts).map(([name, count]) => ({
      name,
      count,
    }));

    return { data };
  }
}

export { DashboardRepository };
