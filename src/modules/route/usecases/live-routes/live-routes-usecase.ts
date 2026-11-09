import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IOperationDayRepository } from "../../repositories/IOperation-day-repository";
import type { IOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/IOccurrence-authorization-repository";

import {
  TOWER_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "../control-tower/operations-viewer";
import { POSITION_WINDOW_MS } from "../control-tower/control-tower-usecase";

import {
  LIVE_ROUTES_CAP,
  decodeLiveRoutesCursor,
  encodeLiveRoutesCursor,
  liveRouteKeyOf,
} from "./live-routes";

import { POSITION_FRESH_MS } from "@/shared/route/driver-position-rules";
import { operationDay } from "@/shared/route/operation-day-rules";
import { isRouteLeftOpen } from "@/shared/route/route-left-open";
import { resolveTimeZone } from "@/shared/time/business-day";

interface LiveRoutesRequest {
  userId: string;
  /** The MASTER names the company, as on the tower. */
  businessId?: string;
  cursor?: string;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface LiveRouteRow {
  id: string;
  code: number;
  name: string | null;
  status: "IN_PROGRESS" | "RELEASED";

  /** The route's civil day, "YYYY-MM-DD". */
  scheduled_date: string;
  started_at: string | null;

  /** Left open (decision D26): the tower's `stale`, by the same rule. */
  stale: boolean;

  driverId: string;
  driver_name: string | null;
  vehicle_plate: string | null;

  stops_total: number;
  stops_resolved: number;

  /** Live requests waiting on this route: the queue's own count. */
  pending_authorizations: number;

  /** The last point when it is inside the map's 12 h; null otherwise. */
  position: { lat: number; lng: number; recorded_at: string } | null;

  /** The last point however old; null when the phone never reported. */
  last_signal_at: string | null;
}

interface LiveRoutes {
  data: LiveRouteRow[];
  meta: {
    /** The company's day the released routes are of ("YYYY-MM-DD"). */
    day: string;
    timeZone: string;

    /** The server's clock at the read: "há N min" is counted from it. */
    generatedAt: string;

    /** The tower's "sem sinal" threshold (10 min), for the same warning. */
    silentAfterMs: number;

    limit: number;

    /** More rows than the cap: the next page starts at `nextCursor`. */
    truncated: boolean;
    nextCursor: string | null;
  };
}

/**
 * The routes on the street, lean (wave 4, GET /route/live).
 *
 * The manager's phone needs the list the tower draws beside the map —
 * driver, plate, "8 de 12", the last signal, what waits for an answer — and
 * none of the rest: no funnel, no events, no punctuality. The tower costs
 * about eight reads per refresh; this is the company's zone (a primary key),
 * one statement for the rows and one for the pending counts of that page.
 * The phone polls it every 60 s while the screen is focused, never in the
 * background, so its cost scales with the managers looking, not with the
 * fleet. The positions ride along because wave 5's map reads the same list.
 *
 * Manager surface, with the tower's rules: a driver token is refused, a
 * MASTER names the company, anyone else reads their own.
 */
@injectable()
class LiveRoutesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
  ) {}

  async execute({
    userId,
    businessId,
    cursor,
    now = new Date(),
  }: LiveRoutesRequest): Promise<LiveRoutes> {
    // A malformed cursor is refused before anything is read.
    const after = cursor ? decodeLiveRoutesCursor(cursor) : undefined;

    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: TOWER_DRIVER_REFUSAL,
    });

    const timeZone = resolveTimeZone(
      await this.operation.timeZoneOf(resolvedBusinessId),
    );

    const day = operationDay(timeZone, now);

    // One row past the cap says whether there is a next page.
    const rows = await this.operation.listLiveRoutes(resolvedBusinessId, {
      date: day.date,
      take: LIVE_ROUTES_CAP + 1,
      after,
    });

    const truncated = rows.length > LIVE_ROUTES_CAP;
    const page = truncated ? rows.slice(0, LIVE_ROUTES_CAP) : rows;

    const pending =
      page.length > 0
        ? await this.authorizations.countPendingByRoute(
            resolvedBusinessId,
            page.map((route) => route.id),
          )
        : new Map<string, number>();

    const mapSince = now.getTime() - POSITION_WINDOW_MS;

    const data = page.map((route): LiveRouteRow => {
      const last = route.lastPosition;

      return {
        id: route.id,
        code: route.code,
        name: route.name,
        status: route.status,
        scheduled_date: route.scheduled_date,
        started_at: route.started_at?.toISOString() ?? null,
        stale:
          route.status === "IN_PROGRESS" &&
          isRouteLeftOpen(route.started_at, timeZone, now),

        driverId: route.driverId,
        driver_name: route.driverName,
        vehicle_plate: route.vehiclePlate,

        stops_total: route.stopsTotal,
        stops_resolved: route.stopsResolved,

        pending_authorizations: pending.get(route.id) ?? 0,

        // A dot from yesterday is not where the truck is: the map draws
        // only the tower's 12 h, and the row says how old the signal is.
        position:
          last && last.recorded_at.getTime() >= mapSince
            ? {
                lat: last.latitude,
                lng: last.longitude,
                recorded_at: last.recorded_at.toISOString(),
              }
            : null,
        last_signal_at: last?.recorded_at.toISOString() ?? null,
      };
    });

    const lastRow = page[page.length - 1];

    return {
      data,
      meta: {
        day: day.date,
        timeZone,
        generatedAt: now.toISOString(),
        silentAfterMs: POSITION_FRESH_MS,
        limit: LIVE_ROUTES_CAP,
        truncated,
        nextCursor:
          truncated && lastRow
            ? encodeLiveRoutesCursor(liveRouteKeyOf(lastRow))
            : null,
      },
    };
  }
}

export { LiveRoutesUseCase };
export type { LiveRouteRow, LiveRoutes };
