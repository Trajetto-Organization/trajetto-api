import {
  DEFAULT_BUSINESS_TIMEZONE,
  dateOnlyFromKey,
  dateOnlyKey,
} from "@/shared/time/business-day";
import { PLANNING_EVENT_TYPES } from "../../usecases/shared/route-plan-rules";
import {
  ROUTE_LOOKBACK_DAYS,
  factInstant,
  failureInstant,
  isFailureOccurrence,
  isWithinDay,
  routeMoveEntry,
  stopSettledAt,
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
} from "../IOperation-day-repository";

/**
 * The rows the operation of a day is read from, in the columns' own names.
 *
 * A twin of several tables because the Prisma repository reads across them in
 * one statement. The contract suite (tests/E2E/operation-day-contract)
 * seeds the same scenario here and in Postgres and demands the same answers.
 */
interface OperationRows {
  businesses: Array<{ id: string; timezone?: string }>;
  drivers: Array<{ id: string; businessId: string; name: string; cnh?: string }>;
  vehicles: Array<{ id: string; license_plate: string }>;

  occurrenceTypes: Array<{ id: string; name: string; blocks_delivery: boolean }>;

  routes: Array<{
    id: string;
    businessId: string;
    code: number;
    name: string | null;
    destination: string | null;
    status: RouteStatusName;
    /** Date-only: UTC midnight of the civil day. */
    scheduled_date: Date;
    planned_departure_at: Date | null;
    started_at: Date | null;
    completed_at: Date | null;
    updated_at: Date;
    driverId: string;
    vehicleId: string | null;
  }>;

  stops: Array<{
    id: string;
    routeId: string;
    deliveryId: string;
    sequence: number;
    status: string;
    on_the_way_at: Date | null;
    arrived_at: Date | null;
    completed_at: Date | null;
    updated_at: Date;
  }>;

  deliveries: Array<{
    id: string;
    businessId: string;
    status: DeliveryStatusName;
    driverId: string | null;
    recipient_name: string;
    city: string;
    delivered_at: Date | null;
    updated_at: Date;
  }>;

  events: Array<{
    id: string;
    businessId: string;
    deliveryId: string;
    routeId: string | null;
    occurrenceId: string | null;
    type: string;
    actor: string;
    status_to: DeliveryStatusName | null;
    occurred_at: Date | null;
    created_at: Date;
  }>;

  /** Optional so the fixtures written before pauses still type-check. */
  pauses?: Array<{
    driverId: string;
    businessId: string;
    started_at: Date;
    ended_at: Date | null;
  }>;

  occurrences: Array<{
    id: string;
    businessId: string;
    deliveryId: string;
    occurrenceTypeId: string;
    authorization_status: string;

    /** Decision 14.3; absent reads as the column default, NOT_DELIVERED. */
    category?: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";

    occurred_at: Date | null;
    created_at: Date;
  }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MONITORING_ORDER: Record<string, number> = {
  IN_PROGRESS: 0,
  RELEASED: 1,
  PLANNED: 2,
};

function emptyRows(): OperationRows {
  return {
    businesses: [],
    drivers: [],
    vehicles: [],
    occurrenceTypes: [],
    routes: [],
    stops: [],
    deliveries: [],
    events: [],
    pauses: [],
    occurrences: [],
  };
}

class InMemoryOperationDayRepository implements IOperationDayRepository {
  public rows: OperationRows = emptyRows();

  async timeZoneOf(businessId: string): Promise<string | null> {
    const business = this.rows.businesses.find((row) => row.id === businessId);

    if (!business) return null;

    // The column's default, like an INSERT that omitted it.
    return business.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
  }

  private dayRouteIds(businessId: string, day: OperationDay): Set<string> {
    return new Set(
      this.rows.routes
        .filter(
          (route) =>
            route.businessId === businessId &&
            route.status !== "CANCELLED" &&
            (dateOnlyKey(route.scheduled_date) === day.date ||
              (day.isToday && route.status === "IN_PROGRESS")),
        )
        .map((route) => route.id),
    );
  }

  private failedAt(delivery: OperationRows["deliveries"][number]): Date {
    const statusChanges = this.rows.events
      .filter(
        (event) =>
          event.deliveryId === delivery.id &&
          event.type === "STATUS_CHANGE" &&
          event.status_to === "FAILED",
      )
      .map((event) => factInstant(event.occurred_at, event.created_at));

    const blocking = this.rows.occurrences
      .filter((occurrence) => {
        const type = this.rows.occurrenceTypes.find(
          (candidate) => candidate.id === occurrence.occurrenceTypeId,
        );

        return (
          occurrence.deliveryId === delivery.id &&
          isFailureOccurrence(type?.blocks_delivery, occurrence.authorization_status)
        );
      })
      .map((occurrence) => factInstant(occurrence.occurred_at, occurrence.created_at));

    const failedStops = this.rows.stops
      .filter((stop) => stop.deliveryId === delivery.id && stop.status === "FAILED")
      .map((stop) => stopSettledAt(stop.completed_at, stop.updated_at));

    return failureInstant(delivery.updated_at, [
      latest(statusChanges),
      latest(blocking),
      latest(failedStops),
    ]);
  }

  async countDayDeliveries(
    businessId: string,
    day: OperationDay,
  ): Promise<DayDeliveryCount[]> {
    const routeIds = this.dayRouteIds(businessId, day);

    // The day's stops, with what the SQL's day_stop carries.
    const dayStops = this.rows.stops
      .filter((stop) => routeIds.has(stop.routeId) && stop.status !== "CANCELLED")
      .map((stop) => {
        const route = this.rows.routes.find((candidate) => candidate.id === stop.routeId);

        return {
          stop,
          ofDay: route !== undefined && dateOnlyKey(route.scheduled_date) === day.date,
          routeDriverId: route?.driverId ?? null,
          settledAt: stopSettledAt(stop.completed_at, stop.updated_at),
        };
      });

    const isOpenStop = (status: string) => status === "PENDING" || status === "ARRIVED";

    const active = new Set<string>();

    for (const { stop, ofDay } of dayStops) {
      // The inner join drops a missing delivery, as in the SQL.
      const delivery = this.rows.deliveries.find((row) => row.id === stop.deliveryId);

      if (!delivery) continue;

      const resolved =
        delivery.status === "DELIVERED" ||
        delivery.status === "FAILED" ||
        delivery.status === "CANCELLED";

      if (isOpenStop(stop.status) || (ofDay && resolved)) active.add(stop.deliveryId);
    }

    // Failed on a route of the day, in the day, and back in the queue with
    // no open stop on the day's routes: that route driver's Insucesso.
    const requeued = new Map<string, { driverId: string | null; settledAt: Date }>();

    for (const { stop, routeDriverId, settledAt } of dayStops) {
      if (stop.status !== "FAILED" || !isWithinDay(settledAt, day)) continue;

      const delivery = this.rows.deliveries.find((row) => row.id === stop.deliveryId);

      if (!delivery || delivery.businessId !== businessId || delivery.status !== "PENDING") {
        continue;
      }

      const reopened = dayStops.some(
        (other) => other.stop.deliveryId === stop.deliveryId && isOpenStop(other.stop.status),
      );

      if (reopened) continue;

      // DISTINCT ON ... ORDER BY settled_at DESC: the latest attempt.
      const current = requeued.get(stop.deliveryId);

      if (!current || current.settledAt.getTime() < settledAt.getTime()) {
        requeued.set(stop.deliveryId, { driverId: routeDriverId, settledAt });
      }
    }

    for (const delivery of this.rows.deliveries) {
      if (delivery.businessId !== businessId) continue;

      if (day.isToday && delivery.status === "IN_TRANSIT") active.add(delivery.id);

      if (delivery.status === "DELIVERED" && isWithinDay(delivery.delivered_at, day)) {
        active.add(delivery.id);
      }

      if (
        delivery.status === "FAILED" &&
        delivery.updated_at.getTime() >= day.start.getTime() &&
        isWithinDay(this.failedAt(delivery), day)
      ) {
        active.add(delivery.id);
      }
    }

    for (const event of this.rows.events) {
      if (
        event.businessId === businessId &&
        event.type === "STATUS_CHANGE" &&
        event.status_to === "CANCELLED" &&
        event.created_at.getTime() >= day.start.getTime() &&
        factInstant(event.occurred_at, event.created_at).getTime() < day.end.getTime() &&
        this.rows.deliveries.some(
          (delivery) => delivery.id === event.deliveryId && delivery.status === "CANCELLED",
        )
      ) {
        active.add(event.deliveryId);
      }
    }

    const counts = new Map<string, DayDeliveryCount>();

    for (const delivery of this.rows.deliveries) {
      // The tenant lock of the final join.
      if (delivery.businessId !== businessId || !active.has(delivery.id)) continue;

      const key = `${delivery.driverId ?? ""}|${delivery.status}`;
      const entry = counts.get(key) ?? {
        driverId: delivery.driverId,
        status: delivery.status,
        total: 0,
      };

      entry.total += 1;
      counts.set(key, entry);
    }

    for (const { driverId } of requeued.values()) {
      const key = `${driverId ?? ""}|FAILED`;
      const entry = counts.get(key) ?? { driverId, status: "FAILED" as const, total: 0 };

      entry.total += 1;
      counts.set(key, entry);
    }

    return [...counts.values()];
  }

  async listDrivers(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ id: string; name: string; cnh: string }>> {
    return this.rows.drivers
      .filter((driver) => driver.businessId === businessId && driverIds.includes(driver.id))
      .map((driver) => ({ id: driver.id, name: driver.name, cnh: driver.cnh ?? "" }));
  }

  private toTowerRoute(route: OperationRows["routes"][number]): TowerRoute {
    return {
      id: route.id,
      code: route.code,
      name: route.name,
      destination: route.destination,
      status: route.status,
      scheduled_date: route.scheduled_date,
      planned_departure_at: route.planned_departure_at,
      started_at: route.started_at,
      completed_at: route.completed_at,
      ended_at:
        route.status === "COMPLETED"
          ? route.completed_at
          : route.status === "CANCELLED"
            ? route.updated_at
            : null,
      driverId: route.driverId,
      driverName:
        this.rows.drivers.find((driver) => driver.id === route.driverId)?.name ?? null,
      vehiclePlate:
        this.rows.vehicles.find((vehicle) => vehicle.id === route.vehicleId)
          ?.license_plate ?? null,
    };
  }

  async listTowerRoutes(
    businessId: string,
    day: OperationDay,
    endedSince: Date,
  ): Promise<TowerRouteWithStops[]> {
    const lookback = lookbackFrom(day);

    return this.rows.routes
      .filter((route) => {
        if (route.businessId !== businessId) return false;

        const recent = route.scheduled_date.getTime() >= lookback;

        return (
          (dateOnlyKey(route.scheduled_date) === day.date && route.status !== "CANCELLED") ||
          (day.isToday && route.status === "IN_PROGRESS") ||
          (route.status === "COMPLETED" &&
            recent &&
            route.completed_at !== null &&
            route.completed_at.getTime() >= endedSince.getTime()) ||
          (route.status === "CANCELLED" &&
            recent &&
            route.started_at !== null &&
            route.updated_at.getTime() >= endedSince.getTime())
        );
      })
      .sort((a, b) => a.code - b.code)
      .map((route) => ({
        ...this.toTowerRoute(route),
        stops:
          route.status === "IN_PROGRESS"
            ? this.rows.stops
                .filter((stop) => stop.routeId === route.id)
                .map((stop) => ({
                  id: stop.id,
                  status: stop.status,
                  on_the_way_at: stop.on_the_way_at,
                }))
            : [],
      }));
  }

  async listFeed(
    businessId: string,
    day: OperationDay,
    limit: number,
  ): Promise<FeedEntry[]> {
    const newestFirst = <T extends { id: string; created_at: Date }>(rows: T[]) =>
      rows
        .sort(
          (a, b) =>
            b.created_at.getTime() - a.created_at.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(0, limit);

    const deliveryOf = (id: string) =>
      this.rows.deliveries.find((delivery) => delivery.id === id);

    const driverNameOf = (driverId: string | null | undefined) =>
      driverId
        ? (this.rows.drivers.find((driver) => driver.id === driverId)?.name ?? null)
        : null;

    const typeOf = (id: string | undefined) =>
      this.rows.occurrenceTypes.find((type) => type.id === id);

    const entries: FeedEntry[] = [];

    const events = newestFirst(
      this.rows.events.filter(
        (event) =>
          event.businessId === businessId &&
          isWithinDay(event.created_at, day) &&
          // The real query's `type NOT IN` (decision 14.7).
          !(PLANNING_EVENT_TYPES as readonly string[]).includes(event.type),
      ),
    );

    for (const event of events) {
      const delivery = deliveryOf(event.deliveryId);
      const occurrence = this.rows.occurrences.find((row) => row.id === event.occurrenceId);
      const type = typeOf(occurrence?.occurrenceTypeId);

      entries.push({
        id: `delivery_event:${event.id}`,
        source: "delivery_event",
        type: event.type,
        actor: event.actor,
        deliveryId: event.deliveryId,
        recipientName: delivery?.recipient_name ?? null,
        routeId: event.routeId,
        routeCode:
          this.rows.routes.find((route) => route.id === event.routeId)?.code ?? null,
        driverName: driverNameOf(delivery?.driverId),
        detail: type?.name ?? event.status_to ?? null,
        failure:
          event.status_to === "FAILED" ||
          (event.type === "OCCURRENCE" &&
            isFailureOccurrence(type?.blocks_delivery, occurrence?.authorization_status)),
        occurredAt: factInstant(event.occurred_at, event.created_at),
        receivedAt: event.created_at,
      });
    }

    const occurrences = newestFirst(
      this.rows.occurrences.filter(
        (occurrence) =>
          occurrence.businessId === businessId &&
          isWithinDay(occurrence.created_at, day) &&
          (occurrence.category ?? "NOT_DELIVERED") === "NOT_DELIVERED" &&
          !this.rows.events.some(
            (event) => event.occurrenceId === occurrence.id && event.type === "OCCURRENCE",
          ),
      ),
    );

    for (const occurrence of occurrences) {
      const delivery = deliveryOf(occurrence.deliveryId);
      const type = typeOf(occurrence.occurrenceTypeId);

      entries.push({
        id: `occurrence:${occurrence.id}`,
        source: "occurrence",
        type: "OCCURRENCE",
        actor: "DRIVER_APP",
        deliveryId: occurrence.deliveryId,
        recipientName: delivery?.recipient_name ?? null,
        routeId: null,
        routeCode: null,
        driverName: driverNameOf(delivery?.driverId),
        detail: type?.name ?? null,
        failure: isFailureOccurrence(type?.blocks_delivery, occurrence.authorization_status),
        occurredAt: factInstant(occurrence.occurred_at, occurrence.created_at),
        receivedAt: occurrence.created_at,
      });
    }

    const lookback = lookbackFrom(day);

    const recent = this.rows.routes.filter(
      (route) => route.businessId === businessId && route.scheduled_date.getTime() >= lookback,
    );

    // One arm per move, each newest first and cut at `limit`, as in the SQL.
    const arm = (
      kind: RouteMoveKind,
      statuses: string[],
      instantOf: (route: OperationRows["routes"][number]) => Date | null,
    ) =>
      recent
        .filter((route) => statuses.includes(route.status) && isWithinDay(instantOf(route), day))
        .map((route) => ({ route, at: instantOf(route) as Date }))
        .sort(
          (a, b) =>
            b.at.getTime() - a.at.getTime() ||
            (a.route.id < b.route.id ? 1 : a.route.id > b.route.id ? -1 : 0),
        )
        .slice(0, limit)
        .map(({ route, at }) =>
          routeMoveEntry({
            id: route.id,
            code: route.code,
            kind,
            at,
            driverName: driverNameOf(route.driverId),
          }),
        );

    entries.push(
      ...arm("ROUTE_STARTED", ["IN_PROGRESS", "COMPLETED", "CANCELLED"], (route) => route.started_at),
      ...arm("ROUTE_COMPLETED", ["COMPLETED"], (route) => route.completed_at),
      ...arm("ROUTE_CANCELLED", ["CANCELLED"], (route) => route.updated_at),
    );

    return entries;
  }

  async listMonitoringRoutes(
    businessId: string,
    day: OperationDay,
    page: { skip: number; take: number },
  ): Promise<{ total: number; routes: MonitoringRoute[] }> {
    const ids = this.dayRouteIds(businessId, day);

    const ordered = this.rows.routes
      .filter((route) => ids.has(route.id))
      .sort(
        (a, b) =>
          (MONITORING_ORDER[a.status] ?? 3) - (MONITORING_ORDER[b.status] ?? 3) ||
          // NULLS LAST, as in the SQL.
          (a.planned_departure_at?.getTime() ?? Infinity) -
            (b.planned_departure_at?.getTime() ?? Infinity) ||
          a.code - b.code,
      );

    const routes = ordered.slice(page.skip, page.skip + page.take).map((route) => ({
      ...this.toTowerRoute(route),
      stops: this.rows.stops
        .filter((stop) => stop.routeId === route.id)
        .sort((a, b) => a.sequence - b.sequence)
        .map((stop) => {
          const delivery = this.rows.deliveries.find((row) => row.id === stop.deliveryId);

          return {
            id: stop.id,
            sequence: stop.sequence,
            status: stop.status,
            deliveryId: stop.deliveryId,
            recipientName: delivery?.recipient_name ?? "",
            city: delivery?.city ?? "",
            on_the_way_at: stop.on_the_way_at,
            arrived_at: stop.arrived_at,
            completed_at: stop.completed_at,
          };
        }),
    }));

    return { total: ordered.length, routes };
  }

  async listOpenPauses(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ driverId: string; started_at: Date }>> {
    return (this.rows.pauses ?? [])
      .filter(
        (pause) =>
          pause.businessId === businessId &&
          pause.ended_at === null &&
          driverIds.includes(pause.driverId),
      )
      .map(({ driverId, started_at }) => ({ driverId, started_at }));
  }
}

function latest(values: Date[]): Date | null {
  if (values.length === 0) return null;

  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function lookbackFrom(day: OperationDay): number {
  return dateOnlyFromKey(day.date).getTime() - ROUTE_LOOKBACK_DAYS * DAY_MS;
}

export { InMemoryOperationDayRepository, emptyRows as emptyOperationRows };
export type { OperationRows };
