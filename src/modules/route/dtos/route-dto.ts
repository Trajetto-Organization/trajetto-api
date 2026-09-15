import type {
  RouteStatus,
  RouteStopStatus,
} from "@/shared/route/route-rules";

interface Route {
  id: string;
  code: number;
  name: string | null;

  status: RouteStatus;

  scheduled_date: Date;
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

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  /** Deliveries to become stops, in the order given. May be empty. */
  deliveryIds: string[];

  /** The upload that created it, when one did. See the Import model. */
  importId?: string | null;
}

interface UpdateRouteProps {
  name?: string | null;
  scheduled_date?: Date;
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
    city: string;
    uf: string;
    street: string;
    address_number: string | null;
    neighborhood: string | null;
  };
}

interface ListRoutesProps {
  businessId: string;
  page: number;
  pageSize: number;

  status?: RouteStatus;
  driverId?: string;
  scheduled_date?: Date;
  search?: string;
}

interface ListRoutesResult {
  data: RouteWithStops[];
  total: number;
  meta: { statusCounts: Record<RouteStatus, number> };
}

export type {
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
