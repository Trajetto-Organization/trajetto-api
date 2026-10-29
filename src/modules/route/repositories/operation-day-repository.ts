import { Prisma, type PrismaClient } from "@prisma/client";

import { PLANNING_EVENT_TYPES } from "../usecases/shared/route-plan-rules";
import database from "@/../infra/database";
import { relatedTo, rowsByKey } from "@/shared/database/related-rows";

import { dateOnlyFromKey, dateOnlyKey } from "@/shared/time/business-day";
import {
  ROUTE_LOOKBACK_DAYS,
  factInstant,
  isFailureOccurrence,
  routeMoveEntry,
  type RouteMoveKind,
} from "@/shared/route/operation-day-rules";

import type {
  DayDeliveryCount,
  DeliveryStatusName,
  FeedEntry,
  IOperationDayRepository,
  MonitoringRoute,
  OperationDay,
  RouteStatusName,
  TowerRoute,
  TowerRouteWithStops,
} from "./IOperation-day-repository";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The earliest `scheduled_date` (date-only) these reads look at. */
function lookbackFrom(day: OperationDay): Date {
  return new Date(
    dateOnlyFromKey(day.date).getTime() - ROUTE_LOOKBACK_DAYS * DAY_MS,
  );
}

/**
 * A UTC timestamp column compared with an instant, whatever the session zone.
 * The instant goes as an ISO string: Prisma 7's pg driver sends a Date as a
 * naive "YYYY-MM-DD HH:MM:SS" in UTC, which `::timestamptz` would read in the
 * session's TimeZone (Prisma 6 bound it as a timestamptz itself).
 */
function utc(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

const towerRouteSelect = {
  id: true,
  code: true,
  name: true,
  destination: true,
  status: true,
  scheduled_date: true,
  planned_departure_at: true,
  started_at: true,
  completed_at: true,
  updated_at: true,
  driverId: true,
  driver: { select: { name: true } },
  vehicle: { select: { license_plate: true } },
} satisfies Prisma.RouteSelect;

type TowerRouteRow = Prisma.RouteGetPayload<{
  select: typeof towerRouteSelect;
}>;

function toTowerRoute(row: TowerRouteRow): TowerRoute {
  const status = row.status as RouteStatusName;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    destination: row.destination,
    status,
    scheduled_date: row.scheduled_date,
    planned_departure_at: row.planned_departure_at,
    started_at: row.started_at,
    completed_at: row.completed_at,

    // A cancellation is terminal, so the row's last update is when it
    // happened (the table has no cancelled_at).
    ended_at:
      status === "COMPLETED"
        ? row.completed_at
        : status === "CANCELLED"
          ? row.updated_at
          : null,

    driverId: row.driverId,
    driverName: row.driver?.name ?? null,
    vehiclePlate: row.vehicle?.license_plate ?? null,
  };
}

type RouteMoveRow = {
  id: string;
  code: number;
  kind: RouteMoveKind;
  at: Date;
  driverName: string | null;
};

class OperationDayRepository implements IOperationDayRepository {
  // A client of its own only in the query-plan suite, which captures SQL.
  constructor(private prisma: PrismaClient = database) {}

  async timeZoneOf(businessId: string): Promise<string | null> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });

    return business?.timezone ?? null;
  }

  /**
   * The active documents of the day, in one statement.
   *
   * Each arm reads through an index of its own: the day's routes through
   * (businessId, status, scheduled_date) and their stops through
   * (routeId, status); DELIVERED through delivery_delivered_today_idx and
   * FAILED through delivery_failed_recent_idx — partial indexes, hence the
   * status literals (a generic plan cannot prove `status = $n` matches
   * them); cancellations through the event log's (businessId, created_at).
   *
   * FAILED is pre-filtered by `updated_at >= start` because every failure
   * fact is stored no later than the status change that followed it; the
   * fact itself then decides the day.
   *
   * A document counts once, under its current status, with one exception: a
   * document that failed on one of the day's routes and went back to the
   * queue (FAILED → PENDING, a new stop on another day's route or none yet)
   * counts as that route driver's Insucesso of the day. Under its current
   * status it sat in today's Pendentes, with tomorrow's driver, and today's
   * failure vanished. One that was put back on a route of the same day is
   * that day's open work again and counts as such.
   *
   * Every arm already holds the delivery row, so it carries the driver and
   * the status the count groups by, and the tenant filter. The count used to
   * join "active" back to "delivery": a plan built with the values bound
   * (every execution on Prisma 7, the first five per connection on 6)
   * estimates IN_TRANSIT of a big tenant from its whole history (thousands
   * of rows for 167), so it hashed all of the company's deliveries to keep
   * 200 — 37 ms against 2 ms on the load fixture. In one statement an id
   * always comes with the same driver and status, so the UNION still keeps
   * each document once.
   */
  async countDayDeliveries(
    businessId: string,
    day: OperationDay,
  ): Promise<DayDeliveryCount[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        driverId: string | null;
        status: DeliveryStatusName;
        total: number;
      }>
    >`
      WITH "day_route" AS (
        SELECT r."id", r."driverId", (r."scheduled_date" = ${day.date}::date) AS "of_day"
        FROM "route" r
        WHERE r."businessId" = ${businessId}
          AND r."status" <> 'CANCELLED'
          AND (
            r."scheduled_date" = ${day.date}::date
            OR (${day.isToday}::boolean AND r."status" = 'IN_PROGRESS')
          )
      ),
      "day_stop" AS MATERIALIZED (
        SELECT
          s."deliveryId",
          s."status",
          dr."of_day",
          dr."driverId" AS "routeDriverId",
          LEAST(s."completed_at", s."updated_at") AS "settled_at"
        FROM "route_stop" s
        JOIN "day_route" dr ON dr."id" = s."routeId"
        WHERE s."status" <> 'CANCELLED'
      ),
      "active" AS (
        -- The day's routes bring their open stops, and what a route OF the
        -- day resolved and stayed resolved. What a route still running from
        -- an earlier day resolved yesterday is yesterday's work.
        SELECT d."id", d."driverId", d."status"
        FROM "day_stop" ds
        JOIN "delivery" d ON d."id" = ds."deliveryId"
        WHERE d."businessId" = ${businessId}
          AND (
            ds."status" IN ('PENDING', 'ARRIVED')
            OR (ds."of_day" AND d."status" IN ('DELIVERED', 'FAILED', 'CANCELLED'))
          )

        UNION

        SELECT d."id", d."driverId", d."status"
        FROM "delivery" d
        WHERE ${day.isToday}::boolean
          AND d."businessId" = ${businessId}
          AND d."status" = 'IN_TRANSIT'

        UNION

        SELECT d."id", d."driverId", d."status"
        FROM "delivery" d
        WHERE d."businessId" = ${businessId}
          AND d."status" = 'DELIVERED'
          AND d."delivered_at" >= ${utc(day.start)}
          AND d."delivered_at" < ${utc(day.end)}

        UNION

        SELECT f."id", f."driverId", f."status"
        FROM (
          SELECT
            d."id",
            d."driverId",
            d."status",
            COALESCE(
              GREATEST(
                (
                  SELECT max(LEAST(COALESCE(e."occurred_at", e."created_at"), e."created_at"))
                  FROM "delivery_event" e
                  WHERE e."deliveryId" = d."id"
                    AND e."type" = 'STATUS_CHANGE'
                    AND e."status_to" = 'FAILED'
                ),
                (
                  SELECT max(LEAST(COALESCE(o."occurred_at", o."created_at"), o."created_at"))
                  FROM "delivery_occurrence" o
                  JOIN "occurrence_type" t ON t."id" = o."occurrenceTypeId"
                  WHERE o."deliveryId" = d."id"
                    AND t."blocks_delivery" = true
                    AND o."authorization_status" IN ('NOT_REQUIRED', 'APPROVED')
                ),
                (
                  SELECT max(LEAST(s."completed_at", s."updated_at"))
                  FROM "route_stop" s
                  WHERE s."deliveryId" = d."id"
                    AND s."status" = 'FAILED'
                )
              ),
              d."updated_at"
            ) AS "failed_at"
          FROM "delivery" d
          WHERE d."businessId" = ${businessId}
            AND d."status" = 'FAILED'
            AND d."updated_at" >= ${utc(day.start)}
          -- A fence: flattened, the planner copies failed_at into both
          -- bounds below and reads every fact of every row twice.
          OFFSET 0
        ) f
        WHERE f."failed_at" >= ${utc(day.start)}
          AND f."failed_at" < ${utc(day.end)}

        UNION

        SELECT d."id", d."driverId", d."status"
        FROM "delivery_event" e
        JOIN "delivery" d ON d."id" = e."deliveryId" AND d."status" = 'CANCELLED'
        WHERE e."businessId" = ${businessId}
          AND d."businessId" = ${businessId}
          AND e."type" = 'STATUS_CHANGE'
          AND e."status_to" = 'CANCELLED'
          AND e."created_at" >= ${utc(day.start)}
          AND LEAST(COALESCE(e."occurred_at", e."created_at"), e."created_at") < ${utc(day.end)}
      ),
      "requeued" AS (
        -- Failed on a route of the day, in the day, and back in the queue
        -- with no open stop on the day's routes: that attempt is the day's.
        SELECT DISTINCT ON (ds."deliveryId") ds."deliveryId" AS "id", ds."routeDriverId" AS "driverId"
        FROM "day_stop" ds
        JOIN "delivery" d ON d."id" = ds."deliveryId"
        WHERE ds."status" = 'FAILED'
          AND d."businessId" = ${businessId}
          AND d."status" = 'PENDING'
          AND ds."settled_at" >= ${utc(day.start)}
          AND ds."settled_at" < ${utc(day.end)}
          AND NOT EXISTS (
            SELECT 1
            FROM "day_stop" o
            WHERE o."deliveryId" = ds."deliveryId"
              AND o."status" IN ('PENDING', 'ARRIVED')
          )
        ORDER BY ds."deliveryId", ds."settled_at" DESC
      )
      SELECT c."driverId", c."status", sum(c."total")::int AS "total"
      FROM (
        SELECT a."driverId", a."status"::text AS "status", count(*)::int AS "total"
        FROM "active" a
        GROUP BY a."driverId", a."status"

        UNION ALL

        SELECT q."driverId", 'FAILED' AS "status", count(*)::int AS "total"
        FROM "requeued" q
        GROUP BY q."driverId"
      ) c
      GROUP BY c."driverId", c."status"
    `;

    return rows.map((row) => ({
      driverId: row.driverId,
      status: row.status,
      total: Number(row.total),
    }));
  }

  async listDrivers(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ id: string; name: string; cnh: string }>> {
    if (driverIds.length === 0) return [];

    return this.prisma.driver.findMany({
      where: { businessId, id: { in: driverIds } },
      select: { id: true, name: true, cnh: true },
    });
  }

  async listTowerRoutes(
    businessId: string,
    day: OperationDay,
    endedSince: Date,
  ): Promise<TowerRouteWithStops[]> {
    const lookback = lookbackFrom(day);

    const rows = await this.prisma.route.findMany({
      where: {
        businessId,
        OR: [
          {
            scheduled_date: dateOnlyFromKey(day.date),
            status: { not: "CANCELLED" },
          },
          ...(day.isToday ? [{ status: "IN_PROGRESS" as const }] : []),
          {
            status: "COMPLETED",
            scheduled_date: { gte: lookback },
            completed_at: { gte: endedSince },
          },
          {
            // Only a route that was on the street leaves a truck behind.
            status: "CANCELLED",
            scheduled_date: { gte: lookback },
            started_at: { not: null },
            updated_at: { gte: endedSince },
          },
        ],
      },
      select: towerRouteSelect,
      orderBy: [{ code: "asc" }],
    });

    const running = rows
      .filter((row) => row.status === "IN_PROGRESS")
      .map((row) => row.id);

    // After the routes, not beside them: one connection per request.
    const stops =
      running.length > 0
        ? await this.prisma.routeStop.findMany({
            where: { routeId: { in: running } },
            select: {
              id: true,
              routeId: true,
              status: true,
              on_the_way_at: true,
            },
          })
        : [];

    return rows.map((row) => ({
      ...toTowerRoute(row),
      stops: stops
        .filter((stop) => stop.routeId === row.id)
        .map((stop) => ({
          id: stop.id,
          status: stop.status,
          on_the_way_at: stop.on_the_way_at,
        })),
    }));
  }

  /**
   * Three sources, each the newest `limit` of the day by arrival.
   *
   * Occurrences are read from their own table: reporting one does not write a
   * delivery event yet, and a blocking one is how most insucessos happen. An
   * occurrence that already has an OCCURRENCE event is skipped so the day
   * that event exists does not list it twice.
   */
  async listFeed(
    businessId: string,
    day: OperationDay,
    limit: number,
  ): Promise<FeedEntry[]> {
    const inDay = { gte: day.start, lt: day.end };

    const events = await this.prisma.deliveryEvent.findMany({
      where: {
        businessId,
        created_at: inDay,
        // A stop added to or taken off a plan is not something that happened
        // on the street (decision 14.7): the planning lines stay in the
        // delivery's own timeline, out of the tower's feed.
        type: { notIn: [...PLANNING_EVENT_TYPES] },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        type: true,
        actor: true,
        status_to: true,
        created_at: true,
        occurred_at: true,
        routeId: true,
        occurrenceId: true,
        deliveryId: true,
      },
    });

    const occurrences = await this.prisma.deliveryOccurrence.findMany({
      where: {
        businessId,
        created_at: inDay,
        events: { none: { type: "OCCURRENCE" } },
        // Only "não entrega" (decision 14.3): a delivery-category occurrence
        // is the proof, already in the feed as its PROOF event, and a pause
        // is not an occurrence of the operation.
        category: "NOT_DELIVERED",
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        created_at: true,
        occurred_at: true,
        authorization_status: true,
        occurrenceTypeId: true,
        deliveryId: true,
      },
    });

    /**
     * What the lines point at, read once for both sources and only for the
     * keys present. As nested selects, Prisma 7 ran each lookup under an
     * empty feed — eight statements on a quiet morning — and the deliveries,
     * types and drivers twice, once per source (shared/database/related-rows.ts).
     */
    const [routes, eventOccurrences] = await Promise.all([
      rowsByKey(
        events.map((event) => event.routeId),
        (ids) =>
          this.prisma.route.findMany({
            where: { id: { in: ids } },
            select: { id: true, code: true },
          }),
      ),
      rowsByKey(
        events.map((event) => event.occurrenceId),
        (ids) =>
          this.prisma.deliveryOccurrence.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              authorization_status: true,
              occurrenceTypeId: true,
            },
          }),
      ),
    ]);

    const [occurrenceTypes, deliveries] = await Promise.all([
      rowsByKey(
        [
          ...[...eventOccurrences.values()].map((row) => row.occurrenceTypeId),
          ...occurrences.map((occurrence) => occurrence.occurrenceTypeId),
        ],
        (ids) =>
          this.prisma.occurrenceType.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, blocks_delivery: true },
          }),
      ),
      rowsByKey(
        [
          ...events.map((event) => event.deliveryId),
          ...occurrences.map((occurrence) => occurrence.deliveryId),
        ],
        (ids) =>
          this.prisma.delivery.findMany({
            where: { id: { in: ids } },
            select: { id: true, recipient_name: true, driverId: true },
          }),
      ),
    ]);

    const drivers = await rowsByKey(
      [...deliveries.values()].map((delivery) => delivery.driverId),
      (ids) =>
        this.prisma.driver.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        }),
    );

    // Deliveries are a required relation of both sources: the foreign key
    // keeps the row, as the nested select assumed.
    const deliveryOf = (deliveryId: string) => {
      const delivery = deliveries.get(deliveryId)!;

      return {
        id: delivery.id,
        recipientName: delivery.recipient_name,
        driverName: relatedTo(drivers, delivery.driverId)?.name ?? null,
      };
    };

    // The date-only bound as a key: a Date cast to `date` in SQL would pass
    // through timestamptz and move a day under a session outside UTC.
    const lookback = dateOnlyKey(lookbackFrom(day));

    /**
     * Each route move is its own arm, newest first and cut at `limit`, like
     * the other two sources: one statement, and never every route the day
     * touched only to show fifteen lines. All three read through
     * route (businessId, status, scheduled_date), bounded by the lookback.
     */
    const routeMoves = await this.prisma.$queryRaw<RouteMoveRow[]>`
      (
        SELECT r."id", r."code", 'ROUTE_STARTED' AS "kind", r."started_at" AS "at", d."name" AS "driverName"
        FROM "route" r
        LEFT JOIN "driver" d ON d."id" = r."driverId"
        WHERE r."businessId" = ${businessId}
          AND r."status" IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')
          AND r."scheduled_date" >= ${lookback}::date
          AND r."started_at" >= ${utc(day.start)}
          AND r."started_at" < ${utc(day.end)}
        ORDER BY r."started_at" DESC, r."id" DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT r."id", r."code", 'ROUTE_COMPLETED' AS "kind", r."completed_at" AS "at", d."name" AS "driverName"
        FROM "route" r
        LEFT JOIN "driver" d ON d."id" = r."driverId"
        WHERE r."businessId" = ${businessId}
          AND r."status" = 'COMPLETED'
          AND r."scheduled_date" >= ${lookback}::date
          AND r."completed_at" >= ${utc(day.start)}
          AND r."completed_at" < ${utc(day.end)}
        ORDER BY r."completed_at" DESC, r."id" DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT r."id", r."code", 'ROUTE_CANCELLED' AS "kind", r."updated_at" AS "at", d."name" AS "driverName"
        FROM "route" r
        LEFT JOIN "driver" d ON d."id" = r."driverId"
        WHERE r."businessId" = ${businessId}
          AND r."status" = 'CANCELLED'
          AND r."scheduled_date" >= ${lookback}::date
          AND r."updated_at" >= ${utc(day.start)}
          AND r."updated_at" < ${utc(day.end)}
        ORDER BY r."updated_at" DESC, r."id" DESC
        LIMIT ${limit}
      )
    `;

    const entries: FeedEntry[] = [];

    for (const event of events) {
      const occurrence = relatedTo(eventOccurrences, event.occurrenceId);
      const type = relatedTo(occurrenceTypes, occurrence?.occurrenceTypeId);
      const delivery = deliveryOf(event.deliveryId);

      entries.push({
        id: `delivery_event:${event.id}`,
        source: "delivery_event",
        type: event.type,
        actor: event.actor,
        deliveryId: delivery.id,
        recipientName: delivery.recipientName,
        routeId: event.routeId,
        routeCode: relatedTo(routes, event.routeId)?.code ?? null,
        driverName: delivery.driverName,
        detail: type?.name ?? event.status_to ?? null,
        // The same judgement as the occurrence row below: a blocking report
        // still waiting for a manager has failed nothing yet (decision 6.3).
        failure:
          event.status_to === "FAILED" ||
          (event.type === "OCCURRENCE" &&
            isFailureOccurrence(
              type?.blocks_delivery,
              occurrence?.authorization_status,
            )),
        occurredAt: factInstant(event.occurred_at, event.created_at),
        receivedAt: event.created_at,
      });
    }

    for (const occurrence of occurrences) {
      const delivery = deliveryOf(occurrence.deliveryId);
      // A required relation, like the delivery.
      const type = occurrenceTypes.get(occurrence.occurrenceTypeId)!;

      entries.push({
        id: `occurrence:${occurrence.id}`,
        source: "occurrence",
        type: "OCCURRENCE",
        // Occurrences are reported from the app; the auditor's "Comprovante
        // rejeitado" is the one exception and names itself in `detail`.
        actor: "DRIVER_APP",
        deliveryId: delivery.id,
        recipientName: delivery.recipientName,
        routeId: null,
        routeCode: null,
        driverName: delivery.driverName,
        detail: type.name,
        failure: isFailureOccurrence(
          type.blocks_delivery,
          occurrence.authorization_status,
        ),
        occurredAt: factInstant(occurrence.occurred_at, occurrence.created_at),
        receivedAt: occurrence.created_at,
      });
    }

    for (const move of routeMoves) {
      entries.push(routeMoveEntry(move));
    }

    return entries;
  }

  async listMonitoringRoutes(
    businessId: string,
    day: OperationDay,
    page: { skip: number; take: number },
  ): Promise<{ total: number; routes: MonitoringRoute[] }> {
    // The page of ids first, in the order a dispatcher reads the board:
    // what is on the street, then what is about to leave, then the rest.
    const ids = await this.prisma.$queryRaw<
      Array<{ id: string; total: number }>
    >`
      SELECT r."id", (count(*) OVER ())::int AS "total"
      FROM "route" r
      WHERE r."businessId" = ${businessId}
        AND r."status" <> 'CANCELLED'
        AND (
          r."scheduled_date" = ${day.date}::date
          OR (${day.isToday}::boolean AND r."status" = 'IN_PROGRESS')
        )
      ORDER BY
        CASE r."status"
          WHEN 'IN_PROGRESS' THEN 0
          WHEN 'RELEASED' THEN 1
          WHEN 'PLANNED' THEN 2
          ELSE 3
        END,
        r."planned_departure_at" ASC NULLS LAST,
        r."code" ASC
      LIMIT ${page.take} OFFSET ${page.skip}
    `;

    if (ids.length === 0) {
      // Past the last page the window has no row to carry the total.
      const total =
        page.skip > 0
          ? await this.prisma.route.count({
              where: {
                businessId,
                status: { not: "CANCELLED" },
                OR: [
                  { scheduled_date: dateOnlyFromKey(day.date) },
                  ...(day.isToday ? [{ status: "IN_PROGRESS" as const }] : []),
                ],
              },
            })
          : 0;

      return { total, routes: [] };
    }

    const rows = await this.prisma.route.findMany({
      where: { businessId, id: { in: ids.map((row) => row.id) } },
      select: {
        ...towerRouteSelect,
        stops: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            sequence: true,
            status: true,
            deliveryId: true,
            on_the_way_at: true,
            arrived_at: true,
            completed_at: true,
            delivery: { select: { recipient_name: true, city: true } },
          },
        },
      },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));

    const routes = ids
      .map((entry) => byId.get(entry.id))
      .filter((row): row is (typeof rows)[number] => Boolean(row))
      .map((row) => ({
        ...toTowerRoute(row),
        stops: row.stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          status: stop.status,
          deliveryId: stop.deliveryId,
          recipientName: stop.delivery.recipient_name,
          city: stop.delivery.city,
          on_the_way_at: stop.on_the_way_at,
          arrived_at: stop.arrived_at,
          completed_at: stop.completed_at,
        })),
      }));

    return { total: Number(ids[0].total), routes };
  }

  async listOpenPauses(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ driverId: string; started_at: Date }>> {
    if (driverIds.length === 0) return [];

    // At most one open pause per driver (driver_pause_one_open_idx).
    return this.prisma.driverPause.findMany({
      where: { businessId, driverId: { in: driverIds }, ended_at: null },
      select: { driverId: true, started_at: true },
    });
  }
}

export { OperationDayRepository };
