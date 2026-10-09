/**
 * The operation of one company's day, read in one place (decision 7.1).
 *
 * The tower, the monitoring tab and the dashboard's "Operação de hoje" said
 * "hoje" with three different queries — deliveries CREATED today, open ones
 * of any day, failures by `updated_at` — and showed three numbers for the same
 * operation. This repository is the one definition they share:
 *
 * A document is ACTIVE on a business day when
 *   - it has a stop (not cancelled) on a route of that day (not cancelled),
 *     or — still open (PENDING/IN_TRANSIT) — on a route running now from an
 *     earlier day when the day is today; or
 *   - it is out with a driver right now (IN_TRANSIT) and the day is today; or
 *   - it was resolved in that day: DELIVERED by `delivered_at`, FAILED by the
 *     latest failure fact (a STATUS_CHANGE to FAILED, a blocking occurrence
 *     that applied, a stop settled as FAILED — `updated_at` only when no fact
 *     exists), CANCELLED by the STATUS_CHANGE that cancelled it.
 *
 * The day is the company's civil day in its own zone (`Business.timezone`),
 * as UTC instants [start, end) plus the date-only key for `scheduled_date`.
 */

type DeliveryStatusName =
  | "PENDING"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED";

type RouteStatusName =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

interface OperationDay {
  /** "YYYY-MM-DD", the company's civil day. */
  date: string;

  /** Start of that day in the company's zone, as a UTC instant. */
  start: Date;

  /** Start of the next day (exclusive). */
  end: Date;

  /**
   * Whether it is the company's current day. Only then do routes still
   * running from an earlier day and deliveries out right now belong to it.
   */
  isToday: boolean;
}

interface DayDeliveryCount {
  driverId: string | null;
  status: DeliveryStatusName;
  total: number;
}

interface TowerRoute {
  id: string;
  code: number;
  name: string | null;
  destination: string | null;
  status: RouteStatusName;

  /** Date-only (UTC midnight of the civil day). */
  scheduled_date: Date;

  planned_departure_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;

  /** completed_at, or when a cancelled route was cancelled; null otherwise. */
  ended_at: Date | null;

  driverId: string;
  driverName: string | null;
  vehiclePlate: string | null;
}

interface TowerRouteWithStops extends TowerRoute {
  /**
   * Stop statuses, only for the routes running now (the tower's list). The id
   * picks the one stop "a caminho" (currentOnTheWayStopId).
   */
  stops: Array<{ id: string; status: string; on_the_way_at: Date | null }>;
}

type FeedSource = "delivery_event" | "occurrence" | "route";

interface FeedEntry {
  /** Unique across sources: `<source>:<row id>[:<what>]`. */
  id: string;
  source: FeedSource;

  /**
   * ARRIVAL | PROOF | STATUS_CHANGE | NOTE | ON_THE_WAY | OCCURRENCE for
   * delivery events and occurrences; ROUTE_STARTED | ROUTE_COMPLETED |
   * ROUTE_CANCELLED for routes.
   */
  type: string;
  actor: string;

  deliveryId: string | null;
  recipientName: string | null;

  routeId: string | null;
  routeCode: number | null;

  driverName: string | null;

  /** The occurrence type, or the status a STATUS_CHANGE moved to. */
  detail: string | null;

  /** A blocking occurrence that applied, or a move to FAILED. */
  failure: boolean;

  /** When it happened (device time for the app's facts). */
  occurredAt: Date;

  /** When the server stored it — the order of the feed. */
  receivedAt: Date;
}

interface MonitoringStop {
  id: string;
  sequence: number;
  status: string;

  deliveryId: string;
  recipientName: string;
  city: string;

  on_the_way_at: Date | null;
  arrived_at: Date | null;
  completed_at: Date | null;
}

interface MonitoringRoute extends TowerRoute {
  stops: MonitoringStop[];
}

interface IOperationDayRepository {
  /** The company's zone, or null when the company does not exist. */
  timeZoneOf: (businessId: string) => Promise<string | null>;

  /** The active documents of the day, by driver and current status. */
  countDayDeliveries: (
    businessId: string,
    day: OperationDay,
  ) => Promise<DayDeliveryCount[]>;

  /**
   * The routes the tower reasons about: scheduled on the day (not cancelled),
   * running now (today only) and ended at or after `endedSince`. Running
   * routes carry their stops' statuses.
   */
  listTowerRoutes: (
    businessId: string,
    day: OperationDay,
    endedSince: Date,
  ) => Promise<TowerRouteWithStops[]>;

  /** The newest facts that reached the server in the day, newest first. */
  listFeed: (
    businessId: string,
    day: OperationDay,
    limit: number,
  ) => Promise<FeedEntry[]>;

  /**
   * Names and CNH of these drivers, only the company's: the board by driver
   * labels the day's counts with them.
   */
  listDrivers: (
    businessId: string,
    driverIds: string[],
  ) => Promise<Array<{ id: string; name: string; cnh: string }>>;

  /**
   * Routes of the day (and running ones, today), not cancelled, with every
   * stop: running first, then released, planned and finished.
   */
  listMonitoringRoutes: (
    businessId: string,
    day: OperationDay,
    page: { skip: number; take: number },
  ) => Promise<{ total: number; routes: MonitoringRoute[] }>;

  /**
   * The pauses still open for these drivers, only the company's: the tower
   * draws a paused truck as such instead of as a stopped one.
   */
  listOpenPauses: (
    businessId: string,
    driverIds: string[],
  ) => Promise<Array<{ driverId: string; started_at: Date }>>;
}

export type {
  DayDeliveryCount,
  DeliveryStatusName,
  FeedEntry,
  FeedSource,
  IOperationDayRepository,
  MonitoringRoute,
  MonitoringStop,
  OperationDay,
  RouteStatusName,
  TowerRoute,
  TowerRouteWithStops,
};
