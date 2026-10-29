import type { RouteStatus, RouteStopStatus } from "@/shared/route/route-rules";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  RouteListFilters,
  RouteListSearchMeta,
  RouteSortKey,
} from "../usecases/list-routes/route-list";

interface Route {
  id: string;
  code: number;
  name: string | null;

  status: RouteStatus;

  scheduled_date: Date;

  /** Where the route is headed, free text (decision 6.5). */
  destination: string | null;

  planned_departure_at: Date | null;
  planned_arrival_at: Date | null;

  started_at: Date | null;
  completed_at: Date | null;
  cancellation_reason: string | null;

  businessId: string;
  driverId: string;
  vehicleId: string | null;

  /**
   * The upload that created it, when one did.
   *
   * On the domain type and not only in the database because the undo finds
   * routes BY it: a fake that dropped this on the way in would let a test
   * prove a spreadsheet's routes are reversible when in fact none of them
   * carries the stamp the reversal looks for.
   */
  importId: string | null;

  /**
   * Bumped on every change to the plan the driver follows (stops added,
   * removed or reordered, crew or window edited). Decision 14.7, D5.
   */
  plan_version: number;

  /** When it was last handed to the driver; null while a draft. */
  released_at: Date | null;

  /** The panel's Idempotency-Key of the create that made it. */
  client_submission_id: string | null;

  created_at: Date;
  updated_at: Date;
}

interface RouteStop {
  id: string;
  sequence: number;
  status: RouteStopStatus;

  arrived_at: Date | null;
  completed_at: Date | null;

  routeId: string;
  deliveryId: string;

  created_at: Date;
  updated_at: Date;
}

interface CreateRouteProps {
  businessId: string;
  driverId: string;
  vehicleId?: string | null;

  name?: string | null;
  scheduled_date: Date;
  destination?: string | null;

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  /** Deliveries to become stops, in the order given. May be empty. */
  deliveryIds: string[];

  /** The upload that created it, when one did. See the Import model. */
  importId?: string | null;

  /** The panel's Idempotency-Key (decision 14.7, §4.7). */
  client_submission_id?: string | null;
}

interface UpdateRouteProps {
  name?: string | null;
  scheduled_date?: Date;
  destination?: string | null;
  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;
  driverId?: string;
  vehicleId?: string | null;
}

/**
 * A status change, carrying the status the caller read and validated against.
 *
 * `expectedStatus` is required rather than optional, the same way
 * `DeliveryStatusPatch` is: it makes the compiler ask for it at every new call
 * site, so a status write added later cannot silently skip the check.
 */
interface RouteTransition {
  expectedStatus: RouteStatus;
  status: RouteStatus;

  vehicleId?: string | null;
  started_at?: Date;
  completed_at?: Date;
  cancellation_reason?: string;
}

/** A route with everything a panel or the driver's app needs in one read. */
interface RouteWithStops extends Route {
  driver: { id: string; name: string } | null;
  vehicle: { id: string; license_plate: string } | null;
  stops: RouteStopWithDelivery[];
}

interface RouteStopWithDelivery extends RouteStop {
  delivery: {
    id: string;
    kind: string;
    status: string;
    recipient_name: string;

    /** Carried so a departure can tell the people waiting. */
    recipient_email?: string | null;
    recipient_telephone?: string | null;

    invoice_number?: string | null;
    code?: string | null;

    /** The NF-e key: one of the three identifiers a webhook payload carries. */
    invoice_key?: string | null;

    scheduled_date?: Date | string | null;
    businessId?: string;
    city: string;
    uf: string;
    street: string;
    address_number: string | null;
    neighborhood: string | null;

    /**
     * Where the ADDRESS is, for the route map (decision 14.7, D7). Null until
     * a dispatcher pins it or a geocoder resolves it.
     */
    latitude?: number | null;
    longitude?: number | null;
    geo_source?: "MANUAL" | "GEOCODER" | null;
  };
}

/** The board's page, sort and filters (route-list.ts holds the rules). */
interface ListRoutesProps extends RouteListFilters {
  page: number;
  pageSize: number;

  sort?: RouteSortKey;
  order?: SortOrder;
}

interface ListRoutesResult {
  data: RouteWithStops[];
  /** Rows of the search and EVERY facet: what the pager draws. */
  total: number;
  /** The cards and the filter options (disjunctive counts). */
  meta: RouteListSearchMeta;
}

interface AssignmentPreviewProps {
  businessId: string;
  driverId: string;
  vehicleId?: string | null;

  /** The day the route would run on (date-only, UTC midnight). */
  day: Date;

  /**
   * The batch assignment's selection, when the preview serves it: a released
   * route whose open stops are all in it is cancelled by the assignment, so
   * it is not a conflict (it is named in `routesEmptiedBySelection`).
   */
  deliveryIds?: string[];

  /**
   * Whether to read the fleet's own facts (open service orders, the last
   * checklist): only for a company with the FLEET module. Without it those
   * records are no longer its operation (decision 4.3), and fleet-maint's own
   * endpoint for the same warning answers MODULE_NOT_ENABLED.
   */
  fleetFacts: boolean;
}

/** What the preview needs to know about the company before it reads. */
interface AssignmentContext {
  /** Business.timezone, resolved (an unknown or missing value is the default). */
  timeZone: string;

  /** The FLEET module is hired and switched on. */
  fleetEnabled: boolean;
}

/** A route the chosen driver or vehicle already has, as the warning names it. */
interface AssignmentRouteRef {
  id: string;
  code: number;
  status: RouteStatus;
  driverName: string | null;
}

interface AssignmentVehicleRef {
  id: string;
  license_plate: string;
  description: string | null;
  status: string;
}

interface AssignmentPreview {
  driver: {
    id: string;
    name: string;
    status: string;
    /** Decision 8.5: the assignment warns, never refuses, over the CNH. */
    cnh_category: string | null;
    /** Date-only (UTC midnight of the civil day). */
    cnh_expires_at: Date | null;
  } | null;

  /** The driver's route on the street right now. */
  driverRunningRoute: AssignmentRouteRef | null;

  /** The driver's other PLANNED/RELEASED routes on the same day. */
  driverRoutesOnDay: AssignmentRouteRef[];

  /** Vehicles in operation whose responsible (Vehicle.driverId) is this driver. */
  responsibleVehicles: AssignmentVehicleRef[];

  vehicle:
    | (AssignmentVehicleRef & {
        /** The vehicle's responsible driver (Vehicle.driverId), if any. */
        responsible: { id: string; name: string } | null;

        /** The CNH category its vehicle type requires, if any (8.5). */
        required_cnh_category: string | null;

        /**
         * Service orders not completed yet (completion_date null). Null when
         * not read: a company without the FLEET module.
         */
        openServiceOrders: { count: number; oldest: Date | null } | null;

        /**
         * The latest checklist, to warn when it was rejected (8.5). Null when
         * there is none, or when not read (no FLEET module).
         */
        lastChecklist: {
          overall_condition: string;
          checklist_date: Date;
        } | null;
      })
    | null;

  /** The vehicle's route on the street right now, of any driver. */
  vehicleRunningRoute: AssignmentRouteRef | null;

  /** The vehicle's PLANNED/RELEASED routes on the same day, of any driver. */
  vehicleRoutesOnDay: AssignmentRouteRef[];

  /**
   * RELEASED routes whose every open stop is in the selection: the batch
   * assignment empties and cancels them, so warning about them is noise.
   */
  routesEmptiedBySelection: string[];
}

/**
 * What every plan write may carry (decision 14.7): the version the
 * dispatcher read (D5) and who did it (the timeline's author).
 */
interface PlanWriteOptions {
  expectedPlanVersion?: number;
  actorId?: string | null;
}

/** The route row as a plan write holds it, locked. */
interface LockedRoute {
  status: RouteStatus;
  driverId: string;
  vehicleId: string | null;
  code: number;
  planVersion: number;
}

/** The state a plan write leaves the route in, for the answer and the hint. */
interface PlanWriteResult {
  planVersion: number;
  status: RouteStatus;
  driverId: string;
  code: number;
}

interface PlanStopsAdded extends PlanWriteResult {
  stops: RouteStop[];
}

interface PlanStopsRemoved extends PlanWriteResult {
  removed: Array<{ stopId: string; deliveryId: string }>;

  /** Ids that are not (or no longer) pending stops of this route. */
  alreadyGone: string[];

  /** No open stop left: the screen offers to unrelease or cancel. */
  routeEmptied: boolean;
}

interface PlanReordered extends PlanWriteResult {
  /** False when the order sent was the order it had (no-op). */
  changed: boolean;
}

interface PlanBump extends PlanWriteResult {
  routeId: string;
}

/** What detaching deliveries from their open routes did. */
interface DetachResult {
  detached: number;

  /** Deliveries on a route that already left: nothing was written. */
  blocked: string[];

  /** Routes left with no stop at all, for the caller to settle. */
  emptiedRoutes: Route[];

  /** Every route that lost a stop, with its new plan version (D5). */
  bumped: PlanBump[];
}

/** A dispatcher pinned (or cleared) a delivery's address on the map. */
interface PinnedLocation {
  /** DELIVERED/CANCELLED: the point belongs to a closed record. */
  locked: boolean;

  delivery: {
    id: string;
    latitude: number | null;
    longitude: number | null;
    geo_source: "MANUAL" | "GEOCODER" | null;
    geo_updated_at: Date | null;
  } | null;

  /** The editable route holding it, when its plan moved a version. */
  route: (PlanWriteResult & { routeId: string }) | null;
}

/** The route a delivery's open stop is on. */
interface OpenStopRoute {
  deliveryId: string;
  stopId: string;
  routeId: string;
  routeCode: number;
  routeStatus: RouteStatus;
}

/** GPS the app captured at a stop (arrival or proof), for the route map. */
interface VisitedPoint {
  deliveryId: string;
  type: "ARRIVAL" | "PROOF";
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export type {
  DetachResult,
  LockedRoute,
  OpenStopRoute,
  PinnedLocation,
  PlanBump,
  PlanReordered,
  PlanStopsAdded,
  PlanStopsRemoved,
  PlanWriteOptions,
  PlanWriteResult,
  VisitedPoint,
  AssignmentContext,
  AssignmentPreview,
  AssignmentPreviewProps,
  AssignmentRouteRef,
  AssignmentVehicleRef,
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  Route,
  RouteStop,
  RouteStopWithDelivery,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
};
