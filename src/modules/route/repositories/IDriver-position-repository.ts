import type { AcceptedPing } from "@/shared/route/driver-position-rules";

interface StoredPosition {
  driverId: string;
  routeId: string | null;

  latitude: number;
  longitude: number;

  accuracy: number | null;
  speed: number | null;
  heading: number | null;

  battery: number | null;

  recorded_at: Date;
}

/** What one flush left in the trail. */
interface RecordedBatch {
  /** New rows; a point already stored (a resend) is neither stored nor dropped. */
  stored: number;

  /** Points no partition can ever hold, dropped so the rest could be written. */
  dropped: number;
}

interface LivePosition extends StoredPosition {
  driverName: string | null;
  vehiclePlate: string | null;

  routeCode: number | null;
}

/**
 * Where the drivers of a company are, and where they have been today.
 *
 * Separate from `IRouteRepository` because the access pattern is nothing like
 * it: this is a write-heavy stream with one reader (a map) over a table
 * partitioned by day, and putting it next to the route's CRUD would invite
 * somebody to join them.
 */
interface IDriverPositionRepository {
  /**
   * One insert for the whole flush.
   *
   * `createMany` and not a loop: a phone coming out of a dead zone sends
   * hundreds of points, and hundreds of round trips for one flush is how the
   * ingest endpoint becomes the slowest route in the product.
   *
   * The trail and the driver's last position commit together, and a point no
   * partition can ever hold is dropped on its own instead of failing the
   * flush (INV-14).
   */
  recordBatch: (props: {
    driverId: string;
    businessId: string;
    routeId: string | null;
    /**
     * The running route's departure. A point recorded before it is stored
     * without the route (routeOfPing): a backlog is not credited to a route
     * that had not left yet.
     */
    routeStartedAt?: Date | null;
    pings: AcceptedPing[];
  }) => Promise<RecordedBatch>;

  /**
   * The latest position of every driver who reported today.
   *
   * One row per driver, which is what a map draws. The whole day's points for
   * one driver is `listTrail`, asked for only when somebody opens a driver.
   */
  listLatestByBusiness: (
    businessId: string,
    since: Date,
  ) => Promise<LivePosition[]>;

  /**
   * When each of these drivers last reported, however long ago.
   *
   * The map only looks twelve hours back; a running route whose phone went
   * quiet before that is not "sem posição desde a saída" — it has a last
   * signal, just an old one. Read by primary key, only for those drivers.
   */
  listLastSignals: (
    businessId: string,
    driverIds: string[],
  ) => Promise<Array<{ driverId: string; recorded_at: Date }>>;

  /** Every point of one driver in [from, to), oldest first, for the trail. */
  listTrail: (props: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;

    /** Only the points recorded on this route (decision 14.7). */
    routeId?: string;
  }) => Promise<StoredPosition[]>;

  /**
   * Whether the driver is one of this company's. The trail asks before
   * reading anything: without it, anybody's day is one id away.
   */
  /**
   * The driver's last known point (driver_last_position), within the
   * company. The route page reads it once; the socket keeps it live.
   */
  findLast: (
    businessId: string,
    driverId: string,
  ) => Promise<StoredPosition | null>;

  hasDriver: (businessId: string, driverId: string) => Promise<boolean>;
}

export type {
  IDriverPositionRepository,
  LivePosition,
  RecordedBatch,
  StoredPosition,
};
