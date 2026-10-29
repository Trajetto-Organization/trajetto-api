import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";
import type { IOperationDayRepository } from "../../repositories/IOperation-day-repository";
import type { IRouteRepository } from "../../repositories/IRoute-repository";

import {
  TOWER_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "../control-tower/operations-viewer";

import { AppError } from "@/shared/errors/AppError";
import { RouteNotFoundError } from "../errors/route-errors";
import { downsample } from "@/shared/route/driver-position-rules";
import { operationDay } from "@/shared/route/operation-day-rules";

interface DriverTrailRequest {
  userId: string;
  driverId: string;

  businessId?: string;

  /** "YYYY-MM-DD" in the company's zone. Defaults to the company's today. */
  day?: string;

  /**
   * Only the points recorded during this route, from its departure to its
   * end (decision 14.7: the route page draws THIS route, not the day).
   */
  routeId?: string;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface TrailPoint {
  latitude: number;
  longitude: number;

  speed: number | null;
  recordedAt: string;
}

interface DriverTrail {
  driverId: string;
  day: string;

  /** How many points exist, before thinning. The screen says so. */
  recorded: number;

  points: TrailPoint[];
}

/**
 * The most points a trail hands to a browser.
 *
 * A ten-hour day at one ping every fifteen seconds is 2.400 points for ONE
 * driver, and the shape of the route is identical at a tenth of them. Four
 * hundred is generous for a polyline and still small enough that opening five
 * drivers at once does not freeze the tab.
 */
const TRAIL_POINT_LIMIT = 400;

/**
 * Where one driver went on one day.
 *
 * Asked for only when somebody opens a driver, never as part of the tower's
 * refresh: the tower draws where trucks ARE, and a screen that fetched every
 * driver's whole day every few seconds would be the heaviest query in the
 * product serving decoration.
 *
 * The day is the COMPANY's, in its own zone (decision 1.1). It used to be the
 * process's local day, which in a UTC container is the UTC day: opened after
 * 21:00 in São Paulo, the trail started at 21:00 and the working morning — the
 * evidence in a dispute about where a truck was at two in the afternoon — was
 * simply not there.
 */
@injectable()
class DriverTrailUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
    @inject("RouteRepository")
    private routes: IRouteRepository,
  ) {}

  async execute({
    userId,
    driverId,
    businessId,
    day,
    routeId,
    now = new Date(),
  }: DriverTrailRequest): Promise<DriverTrail> {
    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: TOWER_DRIVER_REFUSAL,
    });

    // The driver has to be theirs. Without this the trail of anybody's driver
    // is one id away — and a trail is where a person was, all day. The same
    // 404 for "does not exist" and "is not yours".
    if (!(await this.positions.hasDriver(resolvedBusinessId, driverId))) {
      throw new AppError("Motorista não encontrado.", 404, "DRIVER_NOT_FOUND");
    }

    const timeZone = await this.operation.timeZoneOf(resolvedBusinessId);

    if (routeId) {
      return this.routeTrail(
        resolvedBusinessId,
        driverId,
        routeId,
        timeZone,
        now,
      );
    }

    let window;

    try {
      window = operationDay(timeZone, now, day);
    } catch {
      // 2026-02-30 passes the schema's pattern and is still not a day.
      throw new AppError("Data inválida.", 400, "INVALID_DAY");
    }

    const recorded = await this.positions.listTrail({
      businessId: resolvedBusinessId,
      driverId,
      from: window.start,
      to: window.end,
    });

    return this.shape(driverId, window.date, recorded);
  }

  /**
   * The route's own window, departure to end: a route can cross midnight and
   * the day's window would cut it. A route not yet departed has no trail.
   * Another company's route, or another driver's, is the same 404.
   */
  private async routeTrail(
    businessId: string,
    driverId: string,
    routeId: string,
    timeZone: Parameters<typeof operationDay>[0],
    now: Date,
  ): Promise<DriverTrail> {
    const route = await this.routes.findRouteById(routeId, businessId);

    if (!route || route.driverId !== driverId) {
      throw new RouteNotFoundError();
    }

    const date = operationDay(timeZone, route.started_at ?? now).date;

    if (!route.started_at) return this.shape(driverId, date, []);

    const recorded = await this.positions.listTrail({
      businessId,
      driverId,
      routeId,
      from: route.started_at,
      // Half-open: one millisecond past the end keeps the last point.
      to: new Date((route.completed_at ?? now).getTime() + 1),
    });

    return this.shape(driverId, date, recorded);
  }

  private shape(
    driverId: string,
    day: string,
    recorded: Awaited<ReturnType<IDriverPositionRepository["listTrail"]>>,
  ): DriverTrail {
    return {
      driverId,
      day,

      // The real count, alongside the thinned points. A screen that showed
      // only what it drew would have somebody conclude the phone stopped
      // reporting.
      recorded: recorded.length,

      points: downsample(recorded, TRAIL_POINT_LIMIT).map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        speed: point.speed,
        recordedAt: point.recorded_at.toISOString(),
      })),
    };
  }
}

export { DriverTrailUseCase, TRAIL_POINT_LIMIT, type DriverTrail };
