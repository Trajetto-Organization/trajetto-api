import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";
import type {
  FeedEntry,
  IOperationDayRepository,
  TowerRouteWithStops,
} from "../../repositories/IOperation-day-repository";

import {
  TOWER_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "./operations-viewer";

import {
  ENDED_ROUTE_VISIBLE_MS,
  buildFunnel,
  dayProgress,
  mergeFeed,
  placeVehicle,
  routeProgress,
  summarisePunctuality,
  type FunnelStatus,
  type PunctualitySummary,
  type TowerVehicleState,
} from "@/shared/route/control-tower-rules";
import { operationDay } from "@/shared/route/operation-day-rules";
import { dateOnlyKey, resolveTimeZone } from "@/shared/time/business-day";

interface ControlTowerRequest {
  userId: string;
  businessId?: string;

  /** The clock. Only tests pass it; the tower always asks about now. */
  now?: Date;
}

interface TowerPosition {
  driverId: string;
  driverName: string | null;

  routeId: string;
  routeCode: number;
  routeStatus: string;

  vehiclePlate: string | null;

  latitude: number;
  longitude: number;

  speed: number | null;
  heading: number | null;
  battery: number | null;

  recordedAt: string;

  /** Whether the dot still means "where they are" or "where they were". */
  fresh: boolean;

  /** moving, silent (route running, phone quiet) or ended (route finished). */
  state: TowerVehicleState;

  /** When the route ended, for the "concluída às HH:mm" label. */
  endedAt: string | null;

  /**
   * When the driver's open pause started; null when not paused. Only on a
   * running route: a stopped truck on a meal break is not a problem, and the
   * map must not make the dispatcher call about it.
   */
  pausedSince: string | null;
}

/** A route on the street, with or without a dot (TWR-9). */
interface TowerActiveRoute {
  routeId: string;
  routeCode: number;
  routeName: string | null;
  destination: string | null;

  driverId: string;
  driverName: string | null;
  vehiclePlate: string | null;

  startedAt: string | null;

  /** The phone's last point, however old; null only if it never reported. */
  lastSignalAt: string | null;

  progress: { resolved: number; total: number };
}

interface TowerEvent {
  id: string;
  source: FeedEntry["source"];
  type: string;
  actor: string;

  deliveryId: string | null;
  recipientName: string | null;

  routeId: string | null;
  routeCode: number | null;

  driverName: string | null;

  detail: string | null;
  failure: boolean;

  occurredAt: string;
}

interface ControlTower {
  /** The company's day the numbers are about ("YYYY-MM-DD"). */
  day: string;
  timeZone: string;

  positions: TowerPosition[];
  activeRoutes: TowerActiveRoute[];

  funnel: Array<{ status: FunnelStatus; label: string; total: number }>;
  progress: { finished: number; total: number; rate: number | null };

  punctuality: PunctualitySummary;

  events: TowerEvent[];
}

/**
 * How far back the map looks for a dot.
 *
 * Twelve hours, not "today": an operation that starts at five in the morning
 * and a query that starts at midnight agree, but one that runs past midnight
 * does not — and the night shift would watch every truck disappear at 00:00.
 * Which dots are DRAWN is decided by their route (placeVehicle).
 */
const POSITION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** How many events the "últimos eventos" widget shows. */
const EVENT_LIMIT = 15;

/**
 * Everything the tower draws, in one request.
 *
 * One endpoint and not five, because the panel refreshes all of it together
 * and five requests on a timer is five times the connections for a screen a
 * dispatcher leaves open all day. The widgets are FIXED — no customisation —
 * so there is nothing to negotiate per client.
 *
 * "Hoje" is the company's business day in its own zone (decision 7.1): the
 * container runs in UTC, and the counters used to reset at 21:00 in São
 * Paulo. The funnel counts the documents active in that day — the same
 * definition the monitoring board reads — not the ones created in it.
 *
 * Manager surface. A driver token is refused rather than shown the whole
 * operation: the app's permission table opens delivery_manage for the
 * driver's own work, and this is everybody's.
 */
@injectable()
class ControlTowerUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
  ) {}

  async execute({
    userId,
    businessId,
    now = new Date(),
  }: ControlTowerRequest): Promise<ControlTower> {
    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: TOWER_DRIVER_REFUSAL,
    });

    // In sequence, not in a Promise.all: each read is indexed and small, and
    // the tower polls every 30 s in every open tab. A pool is shared with the
    // writes of the whole fleet.
    const timeZone = resolveTimeZone(
      await this.operation.timeZoneOf(resolvedBusinessId),
    );

    const day = operationDay(timeZone, now);

    const positions = await this.positions.listLatestByBusiness(
      resolvedBusinessId,
      new Date(now.getTime() - POSITION_WINDOW_MS),
    );

    const routes = await this.operation.listTowerRoutes(
      resolvedBusinessId,
      day,
      new Date(now.getTime() - ENDED_ROUTE_VISIBLE_MS),
    );

    const counts = await this.operation.countDayDeliveries(
      resolvedBusinessId,
      day,
    );

    const feed = await this.operation.listFeed(
      resolvedBusinessId,
      day,
      EVENT_LIMIT,
    );

    const placed = positions.flatMap((position) => {
      const vehicle = placeVehicle(position, routes, now);

      if (!vehicle) return [];

      const route: TowerRouteWithStops = vehicle.route;

      return [
        {
          driverId: position.driverId,
          driverName: position.driverName ?? route.driverName,

          routeId: route.id,
          routeCode: route.code,
          routeStatus: route.status,

          // The plate of the route that explains the dot; the join on the
          // point's own route only when that one has none.
          vehiclePlate: route.vehiclePlate ?? position.vehiclePlate,

          latitude: position.latitude,
          longitude: position.longitude,

          speed: position.speed,
          heading: position.heading,
          battery: position.battery,

          recordedAt: position.recorded_at.toISOString(),

          fresh: vehicle.state === "moving",
          state: vehicle.state,
          endedAt: route.ended_at?.toISOString() ?? null,
          pausedSince: null as string | null,
        } satisfies TowerPosition,
      ];
    });

    // After the dots, and only for trucks still on a route: a finished
    // route's driver going to lunch is not the tower's business.
    const onRoute = placed
      .filter((position) => position.state !== "ended")
      .map((position) => position.driverId);

    const pausedSince = new Map(
      (await this.operation.listOpenPauses(resolvedBusinessId, onRoute)).map(
        (pause) => [pause.driverId, pause.started_at.toISOString()],
      ),
    );

    for (const position of placed) {
      if (position.state !== "ended") {
        position.pausedSince = pausedSince.get(position.driverId) ?? null;
      }
    }

    const lastSignal = new Map(
      positions.map((position) => [position.driverId, position.recorded_at]),
    );

    const running = routes.filter((route) => route.status === "IN_PROGRESS");

    // A running route whose phone went quiet before the map's window still
    // HAS a last signal: only a phone that never reported is "sem posição".
    const quiet = running
      .map((route) => route.driverId)
      .filter((driverId) => !lastSignal.has(driverId));

    for (const signal of await this.positions.listLastSignals(
      resolvedBusinessId,
      [...new Set(quiet)],
    )) {
      lastSignal.set(signal.driverId, signal.recorded_at);
    }

    const activeRoutes = running.map((route) => {
      const progress = routeProgress(route.stops);

      return {
        routeId: route.id,
        routeCode: route.code,
        routeName: route.name,
        destination: route.destination,

        driverId: route.driverId,
        driverName: route.driverName,
        vehiclePlate: route.vehiclePlate,

        startedAt: route.started_at?.toISOString() ?? null,
        lastSignalAt: lastSignal.get(route.driverId)?.toISOString() ?? null,

        progress: {
          resolved: progress.delivered + progress.failed,
          total: progress.total - progress.cancelled,
        },
      } satisfies TowerActiveRoute;
    });

    // Punctuality is about the day's plan only: tomorrow's routes are not
    // "não saíram" today, and a cancelled route has no departure to judge.
    const todaysRoutes = routes.filter(
      (route) =>
        route.status !== "CANCELLED" &&
        dateOnlyKey(route.scheduled_date) === day.date,
    );

    return {
      day: day.date,
      timeZone,

      positions: placed,
      activeRoutes,

      funnel: buildFunnel(counts),
      progress: dayProgress(counts),

      punctuality: summarisePunctuality(todaysRoutes, now),

      events: mergeFeed([feed], EVENT_LIMIT).map((entry) => ({
        id: entry.id,
        source: entry.source,
        type: entry.type,
        actor: entry.actor,

        deliveryId: entry.deliveryId,
        recipientName: entry.recipientName,

        routeId: entry.routeId,
        routeCode: entry.routeCode,

        driverName: entry.driverName,

        detail: entry.detail,
        failure: entry.failure,

        // Listed in the order they reached us, stamped with when they
        // happened: an offline proof shows its real hour (MOB-08).
        occurredAt: entry.occurredAt.toISOString(),
      })),
    };
  }
}

export {
  ControlTowerUseCase,
  EVENT_LIMIT,
  POSITION_WINDOW_MS,
  type ControlTower,
  type TowerActiveRoute,
  type TowerEvent,
  type TowerPosition,
};
