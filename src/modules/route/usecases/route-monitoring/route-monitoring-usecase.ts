import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IOperationDayRepository } from "../../repositories/IOperation-day-repository";

import {
  PANEL_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "../control-tower/operations-viewer";

import { AppError } from "@/shared/errors/AppError";

import { routeProgress, type RouteProgress } from "@/shared/route/control-tower-rules";
import { operationDay } from "@/shared/route/operation-day-rules";
import { dateOnlyKey, resolveTimeZone } from "@/shared/time/business-day";

interface RouteMonitoringRequest {
  userId: string;
  businessId?: string;

  /** "YYYY-MM-DD" in the company's zone. Defaults to the company's today. */
  day?: string;

  page: number;
  pageSize: number;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface MonitoredStop {
  id: string;
  sequence: number;
  status: string;

  deliveryId: string;
  recipientName: string;
  city: string;

  onTheWayAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
}

interface MonitoredRoute {
  id: string;
  code: number;
  name: string | null;
  destination: string | null;
  status: string;

  /** Date-only "YYYY-MM-DD" — a day, not an instant (decision 1.3). */
  scheduledDate: string;

  plannedDepartureAt: string | null;
  startedAt: string | null;
  completedAt: string | null;

  driver: { id: string; name: string | null };
  vehiclePlate: string | null;

  progress: RouteProgress;
  stops: MonitoredStop[];
}

interface RouteMonitoring {
  day: string;

  /** The company's zone: the board shows every hour in it, like the tower. */
  timeZone: string;

  routes: MonitoredRoute[];
  meta: { total: number; page: number; pageSize: number };
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * The monitoring board by route (decision 6.6, DLVP-MON-1): every route of
 * the company's day — and every route still running, today — with its
 * completion and one entry per stop, in the route's order.
 *
 * Manager surface, like the tower: a driver token is refused rather than
 * shown everybody's day.
 */
@injectable()
class RouteMonitoringUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
  ) {}

  async execute({
    userId,
    businessId,
    day,
    page,
    pageSize,
    now = new Date(),
  }: RouteMonitoringRequest): Promise<RouteMonitoring> {
    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: PANEL_DRIVER_REFUSAL,
    });

    const timeZone = resolveTimeZone(await this.operation.timeZoneOf(resolvedBusinessId));

    let window;

    try {
      window = operationDay(timeZone, now, day);
    } catch {
      throw new AppError("Data inválida.", 400, "INVALID_DAY");
    }

    const { total, routes } = await this.operation.listMonitoringRoutes(
      resolvedBusinessId,
      window,
      { skip: (page - 1) * pageSize, take: pageSize },
    );

    return {
      day: window.date,
      timeZone,
      meta: { total, page, pageSize },
      routes: routes.map((route) => ({
        id: route.id,
        code: route.code,
        name: route.name,
        destination: route.destination,
        status: route.status,

        scheduledDate: dateOnlyKey(route.scheduled_date),

        plannedDepartureAt: iso(route.planned_departure_at),
        startedAt: iso(route.started_at),
        completedAt: iso(route.completed_at),

        driver: { id: route.driverId, name: route.driverName },
        vehiclePlate: route.vehiclePlate,

        progress: routeProgress(route.stops),

        stops: route.stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          status: stop.status,
          deliveryId: stop.deliveryId,
          recipientName: stop.recipientName,
          city: stop.city,
          onTheWayAt: iso(stop.on_the_way_at),
          arrivedAt: iso(stop.arrived_at),
          completedAt: iso(stop.completed_at),
        })),
      })),
    };
  }
}

export {
  RouteMonitoringUseCase,
  type MonitoredRoute,
  type MonitoredStop,
  type RouteMonitoring,
};
