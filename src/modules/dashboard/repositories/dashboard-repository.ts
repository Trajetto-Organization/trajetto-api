import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import {
  CountByDateRangeParams,
  CountByDateRangeResult,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountResult,
  ModelWithCount,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
} from "../dtos/dashboard-dto";

import { IDashboardRepository } from "./IDashboard-repository";

class DashboardRepository implements IDashboardRepository {
  constructor(private prisma = database) {}

  async countByDateRange(
    params: CountByDateRangeParams,
    businessId?: string,
  ): Promise<CountByDateRangeResult> {
    // Determines which model to use based on the entity parameter
    let model: ModelWithCount;
    switch (params.entity) {
      case "vehicle":
        model = this.prisma.vehicle;
        break;
      case "driver":
        model = this.prisma.driver;
        break;
      case "business":
        model = this.prisma.business;
        break;
      case "branch":
        model = this.prisma.branch;
        break;
      case "part":
        model = this.prisma.part;
        break;
      case "supplier":
        model = this.prisma.supplier;
        break;
      case "service-order":
        model = this.prisma.serviceOrder;
        break;
      case "user":
        model = this.prisma.user;
        break;
      case "fine":
        model = this.prisma.fine;
        break;
      default:
        throw new Error("Entidade inválida");
    }

    // Convert date string to local timezone Date objects
    // params.startDate and params.endDate are in format "YYYY-MM-DD"
    const [startYear, startMonth, startDay] = params.startDate
      .split("-")
      .map(Number);
    const [endYear, endMonth, endDay] = params.endDate.split("-").map(Number);

    // Create dates in local timezone (server timezone - Brazil UTC-3)
    const startDateLocal = new Date(
      startYear,
      startMonth - 1,
      startDay,
      0,
      0,
      0,
      0,
    );
    const endDateLocal = new Date(
      endYear,
      endMonth - 1,
      endDay,
      23,
      59,
      59,
      999,
    );

    const whereClause: any = {
      created_at: {
        gte: startDateLocal,
        lte: endDateLocal,
      },
    };

    if (businessId) {
      whereClause.businessId = businessId;
    }

    if (params.entity === "user") {
      whereClause.role = { not: "MASTER" };
    }

    const count = await model.count({ where: whereClause });
    return { count };
  }

/**
   * The table and the extra predicate behind each entity name.
   *
   * A map and not a switch, because this is used to build raw SQL and a switch
   * that fell through would build a query against whatever the last case left
   * in the variable. Every table name here is a literal in this file: nothing
   * from a request ever reaches the string.
   */
  private static readonly MONTHLY_SOURCES: Record<
    CountByMonthParams["entity"],
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
  };

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
      entities: CountByMonthParams["entity"][];
      from: Date;
      to: Date;
    },
    businessId?: string,
  ): Promise<Record<string, MonthlyCountBucket[]>> {
    const result: Record<string, MonthlyCountBucket[]> = {};

    const wanted = params.entities.filter(
      (entity) => DashboardRepository.MONTHLY_SOURCES[entity],
    );

    for (const entity of params.entities) result[entity] = [];

    if (wanted.length === 0) return result;

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const parts = wanted.map((entity) => {
      const source = DashboardRepository.MONTHLY_SOURCES[entity];

      // `business` has no businessId of its own — it IS the tenant — so
      // scoping it by one would count zero and quietly blank the card.
      const tenant =
        businessId && entity !== "business"
          ? Prisma.sql`AND "businessId" = ${businessId}`
          : Prisma.empty;

      return Prisma.sql`
        SELECT
          ${entity} AS entity,
          to_char(
            date_trunc(
              'month',
              ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}
            ),
            'YYYY-MM'
          ) AS month,
          count(*)::bigint AS count
        FROM ${Prisma.raw(`"public"."${source.table}"`)}
        WHERE "created_at" >= ${params.from}
          AND "created_at" <= ${params.to}
          ${tenant}
          ${source.extra ?? Prisma.empty}
        GROUP BY 1, 2
      `;
    });

    const rows = await this.prisma.$queryRaw<
      Array<{ entity: string; month: string; count: bigint }>
    >(Prisma.join(parts, " UNION ALL "));

    for (const row of rows) {
      (result[row.entity] ??= []).push({
        month: row.month,
        count: Number(row.count),
      });
    }

    return result;
  }

  async countByMonth(
    params: CountByMonthParams,
    businessId?: string,
  ): Promise<MonthlyCountBucket[]> {
    const source = DashboardRepository.MONTHLY_SOURCES[params.entity];

    if (!source) {
      throw new Error("Entidade inválida");
    }

    // `business` has no businessId of its own — it IS the tenant — so scoping
    // it by one would count zero and quietly blank the card.
    const tenant =
      businessId && params.entity !== "business"
        ? Prisma.sql`AND "businessId" = ${businessId}`
        : Prisma.empty;

    /**
     * Grouped by the month in the SERVER's timezone, not in the database's.
     *
     * `created_at` is `timestamp WITHOUT time zone` holding a UTC instant, and
     * the database session runs in UTC — so a plain `date_trunc` groups by the
     * UTC month. The cards were always computed from local month boundaries
     * (`new Date(year, month, 1)`), and the two disagree for everything
     * created between 21:00 and midnight on the last day of a Brazilian month:
     * those rows are already the 1st in UTC.
     *
     * A card that is wrong by a day at the start of every month is wrong
     * exactly when somebody looks at it. So the value is read back into local
     * wall time before it is truncated, which is what the old per-month loop
     * effectively did.
     */
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const rows = await this.prisma.$queryRaw<
      Array<{ month: string; count: bigint }>
    >(Prisma.sql`
      SELECT
        to_char(
          date_trunc(
            'month',
            ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}
          ),
          'YYYY-MM'
        ) AS month,
        count(*)::bigint AS count
      FROM ${Prisma.raw(`"public"."${source.table}"`)}
      WHERE "created_at" >= ${params.from}
        AND "created_at" <= ${params.to}
        ${tenant}
        ${source.extra ?? Prisma.empty}
      GROUP BY 1
    `);

    return rows.map((row) => ({
      month: row.month,
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

    const [active, inactive, blocked, inRoute] = await Promise.all([
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "ACTIVE",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "INACTIVE",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "BLOCKED",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "IN_ROUTE",
        },
      }),
    ]);

    return {
      ACTIVE: active,
      INACTIVE: inactive,
      BLOCKED: blocked,
      IN_ROUTE: inRoute,
    };
  }

  async getMaintenanceStats(
    businessId?: string,
  ): Promise<MaintenanceStatsResult> {
    const whereClause: any = {};

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where: whereClause,
      select: {
        id: true,
        last_maintenance_date: true,
        maintenance_interval_months: true,
        current_mileage: true,
        last_maintenance_mileage: true,
        maintenance_interval_km: true,
      },
    });

    const now = new Date();

    let pending = 0;
    let recent = 0;

    let overdue = 0;
    vehicles.forEach((vehicle) => {
      if (!vehicle.last_maintenance_date) {
        pending++;
        return;
      }

      const lastMaintenanceDate = new Date(vehicle.last_maintenance_date);

      // Calculate next maintenance date (by time)
      const nextMaintenanceDate = new Date(lastMaintenanceDate);
      nextMaintenanceDate.setMonth(
        nextMaintenanceDate.getMonth() + vehicle.maintenance_interval_months,
      );

      // Calculate next maintenance by mileage
      const nextMaintenanceKm =
        (vehicle.last_maintenance_mileage as number) +
        vehicle.maintenance_interval_km;
      const kmOverdue = vehicle.current_mileage >= nextMaintenanceKm;

      // Calculate days until next maintenance
      const daysUntilMaintenance = Math.floor(
        (nextMaintenanceDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (daysUntilMaintenance < 0 || kmOverdue) {
        overdue++;
      } else if (daysUntilMaintenance <= 30) {
        pending++;
      } else {
        recent++;
      }
    });

    return {
      pending,
      recent,
      overdue,
    };
  }

  async getMonthlyCosts(
    params: MonthlyCostsParams,
    businessId?: string,
  ): Promise<MonthlyCostsResult> {
    // Convert date string to local timezone Date objects
    // params.startDate and params.endDate are in format "YYYY-MM-DD"
    const [startYear, startMonth, startDay] = params.startDate
      .split("-")
      .map(Number);
    const [endYear, endMonth, endDay] = params.endDate.split("-").map(Number);

    // Create dates in local timezone (server timezone - Brazil UTC-3)
    const startDateLocal = new Date(
      startYear,
      startMonth - 1,
      startDay,
      0,
      0,
      0,
      0,
    );
    const endDateLocal = new Date(
      endYear,
      endMonth - 1,
      endDay,
      23,
      59,
      59,
      999,
    );

    const whereClause: any = {
      created_at: {
        gte: startDateLocal,
        lte: endDateLocal,
      },
    };

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const serviceOrders = await this.prisma.serviceOrder.findMany({
      where: whereClause,
      select: {
        id: true,
        maintenance_type: true,
        total_amount: true,
        created_at: true,
      },
    });

    let preventive = 0;
    let corrective = 0;

    serviceOrders.forEach((order) => {
      if (order.maintenance_type === "INTERNAL") {
        preventive += Number(order.total_amount);
      } else {
        corrective += Number(order.total_amount);
      }
    });

    return {
      preventive,
      corrective,
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
   *
   * Grouped in local wall time, for the same reason `countByMonth` is: the
   * column is naive UTC and the cards were always drawn on local months.
   */
  async getCostsByMonth(
    params: { from: Date; to: Date },
    businessId?: string,
  ): Promise<MonthlyCostBucket[]> {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const tenant = businessId
      ? Prisma.sql`AND "businessId" = ${businessId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ month: string; preventive: string; corrective: string }>
    >(Prisma.sql`
      SELECT
        to_char(
          date_trunc(
            'month',
            ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}
          ),
          'YYYY-MM'
        ) AS month,

        -- INTERNAL is what the screen calls preventive, exactly as the old
        -- JavaScript branch decided it. Everything else is corrective.
        COALESCE(
          SUM("total_amount") FILTER (WHERE "maintenance_type" = 'INTERNAL'),
          0
        )::text AS preventive,

        COALESCE(
          SUM("total_amount") FILTER (WHERE "maintenance_type" <> 'INTERNAL'),
          0
        )::text AS corrective
      FROM "public"."service_order"
      WHERE "created_at" >= ${params.from}
        AND "created_at" <= ${params.to}
        ${tenant}
      GROUP BY 1
    `);

    return rows.map((row) => ({
      month: row.month,
      preventive: Number(row.preventive),
      corrective: Number(row.corrective),
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
