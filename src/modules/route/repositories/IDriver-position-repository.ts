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
   */
  recordBatch: (props: {
    driverId: string;
    businessId: string;
    routeId: string | null;
    pings: AcceptedPing[];
  }) => Promise<number>;

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

  /** Every point of one driver in a window, oldest first, for the trail. */
  listTrail: (props: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;
  }) => Promise<StoredPosition[]>;
}

export type { IDriverPositionRepository, LivePosition, StoredPosition };
