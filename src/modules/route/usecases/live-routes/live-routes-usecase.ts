import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type {
  IOperationDayRepository,
  LiveRouteKey,
} from "../../repositories/IOperation-day-repository";
import type { IOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/IOccurrence-authorization-repository";

import {
  TOWER_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "../control-tower/operations-viewer";
import { POSITION_WINDOW_MS } from "../control-tower/control-tower-usecase";
import {
  towerSnapshot,
  type SnapshotBody,
} from "../control-tower/tower-snapshot";

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
import type { TenantSnapshotRead } from "@/shared/cache/tenant-snapshot";

interface LiveRoutesRequest {
  userId: string;
  /** The MASTER names the company, as on the tower. */
  businessId?: string;
  cursor?: string;

  /** The clock. Only tests pass it. */
  now?: Date;
}

/** The first page only: a page with a cursor is read as before. */
interface LiveRoutesSnapshotRequest {
  userId: string;
  businessId?: string;

  /** x-trajetto-refresh: a read newer than the copy, if it is 2 s old. */
  refresh: boolean;

  /** The route's serializer: the page becomes the body it would send. */
  body: SnapshotBody<LiveRoutes>;
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
/**
 * The first page of each company's live routes, once per
 * TOWER_SNAPSHOT_TTL_MS in this process (plano-escala F4-11): every
 * manager's phone polls the same list. The query is in the key — the first
 * page, no cursor —, so a page that follows a cursor never meets it.
 */
const liveRoutesSnapshot = towerSnapshot("route-live");

const FIRST_PAGE = { cursor: null };

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

    return this.build(await this.resolve(userId, businessId), after, now);
  }

  /**
   * The first page through the company's snapshot (F4-11): the same checks,
   * on every request and before the snapshot is looked at, then the body of
   * the company's copy, computed once per interval outside this request.
   */
  async executeSnapshot({
    userId,
    businessId,
    refresh,
    body,
  }: LiveRoutesSnapshotRequest): Promise<TenantSnapshotRead> {
    const resolvedBusinessId = await this.resolve(userId, businessId);

    return liveRoutesSnapshot.read({
      businessId: resolvedBusinessId,
      variant: FIRST_PAGE,
      refresh,
      compute: async () =>
        body(await this.build(resolvedBusinessId, undefined, new Date())),
    });
  }

  private resolve(userId: string, businessId?: string): Promise<string> {
    return resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: TOWER_DRIVER_REFUSAL,
    });
  }

  /** One page of the company's routes at `now`; nothing of who asked. */
  private async build(
    resolvedBusinessId: string,
    after: LiveRouteKey | undefined,
    now: Date,
  ): Promise<LiveRoutes> {
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

export { LiveRoutesUseCase, liveRoutesSnapshot };
export type { LiveRouteRow, LiveRoutes };
