import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import {
  isStopOpen,
  nextSequence,
  resequence,
  routeCodeFromSearch,
  routeCompletedAt,
} from "@/shared/route/route-rules";
import { resolveTimeZone } from "@/shared/time/business-day";
import {
  ROUTE_COLUMN_DEFAULTS,
  ROUTE_STOP_COLUMN_DEFAULTS,
} from "@/shared/in-memory/column-defaults";
import { asDateColumn } from "@/shared/in-memory/date-column";
import {
  compareForOrder,
  type NullsPlacement,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";

import {
  ROUTE_LIST_STATUSES,
  ROUTE_SORT_FALLBACK,
  catalogFacetOptions,
  summarizeRouteList,
  type GroupCount,
  type RouteFacet,
  type RouteSortKey,
} from "../../usecases/list-routes/route-list";

import {
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
  RouteDriverBusyError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopsLimitError,
  RouteVehicleBusyError,
} from "../../usecases/errors/route-errors";
import {
  PLANNING_TIMELINE_EVENTS_ENABLED,
  ROUTE_MAX_STOPS,
  assertPlanVersion,
} from "../../usecases/shared/route-plan-rules";
import type {
  UnroutedDeliveriesPage,
  UnroutedDeliveriesQuery,
  UnroutedFacet,
} from "../../usecases/list-unrouted-deliveries/unrouted-deliveries";
import { orderShipperFacet } from "../../usecases/list-unrouted-deliveries/unrouted-deliveries";

import type { IRouteRepository } from "../IRoute-repository";
import type {
  AssignmentContext,
  AssignmentPreview,
  AssignmentPreviewProps,
  AssignmentRouteRef,
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  OpenStopRoute,
  PinnedLocation,
  DetachResult,
  PlanBump,
  PlanReordered,
  PlanStopsAdded,
  PlanStopsRemoved,
  PlanWriteOptions,
  Route,
  RouteStop,
  RouteStopWithDelivery,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
  VisitedPoint,
} from "../../dtos/route-dto";

import type { RouteStatus, RouteStopStatus } from "@/shared/route/route-rules";

/**
 * A stand-in for Postgres, and the rules it enforces are not decoration.
 *
 * Three kinds of guarantee live in the real repository's `where` rather than
 * in application code: the tenant scope, the status precondition, and the two
 * partial unique indexes. A fake that skipped any of them would accept writes
 * the real repository refuses, and the tests built on it would prove the
 * opposite of the truth. So all three are mirrored here, raising the same
 * errors — including the one that matters most: a route reached from the wrong
 * company behaves exactly like a route that does not exist.
 */
const EDITABLE_STATUSES: RouteStatus[] = ["PLANNED", "RELEASED"];

/** How many routes or vehicles a preview lists, as the real query takes. */
const PREVIEW_LIMIT = 5;

/** Mirrors `route-rules`: a stop nobody has finished yet. */
const OPEN_STOP_STATUSES = ["PENDING", "ARRIVED"];

/**
 * The shape this repository needs from a delivery row. Deliberately a subset,
 * and every field optional that is optional on the real DTO, so a test can
 * hand over the delivery fake's OWN array instead of a copy — routes and
 * deliveries are one table in Postgres, and a test where they are two stores
 * can show a departure that moved nothing.
 */
/**
 * What this repository needs from a vehicle row: the status it owns, and —
 * for the assignment preview — the plate and its responsible driver.
 */
interface VehicleMirror {
  id?: string;
  businessId: string;
  status?: string;
  license_plate?: string;
  description?: string | null;
  driverId?: string | null;
  created_at?: Date | string;

  /** Its vehicle type's required CNH category (decision 8.5). */
  required_cnh_category?: string | null;

  /** The start dates of its service orders not completed yet. */
  open_service_orders?: Date[];

  /** Its latest checklist, as the real query takes it. */
  last_checklist?: { overall_condition: string; checklist_date: Date } | null;
}

/** What the assignment preview reads of a driver row. */
interface DriverMirror {
  id?: string;
  businessId: string;
  name?: string;
  status?: string;
  cnh_category?: string | null;
  cnh_expires_at?: Date | null;
}

interface DeliveryMirror {
  id?: string;
  businessId: string;
  driverId?: string | null;
  vehicleId?: string | null;
  kind?: string;
  status?: string;
  recipient_name?: string;

  /**
   * The contact details a departure needs to tell the person waiting.
   *
   * Carried here because the real repository's stop projection carries them:
   * a fake that dropped them would let a test prove the departure notifies
   * nobody, when in fact it notifies everybody — the one direction a fake must
   * never be wrong in.
   */
  recipient_email?: string | null;
  recipient_telephone?: string | null;

  invoice_number?: string | null;
  code?: string | null;

  /** The NF-e key, which `delivery.assigned` payloads carry. */
  invoice_key?: string | null;

  scheduled_date?: Date | string | null;

  // The picker's columns (decision 14.7): optional, so the fixtures that
  // never needed them keep working; the real row always has them.
  city?: string;
  uf?: string;
  street?: string;
  shipperId?: string;
  created_at?: Date | string;

  /** The address point (D7). */
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: "MANUAL" | "GEOCODER" | null;
  geo_updated_at?: Date | null;
}

/** A delivery_event row this repository writes or reads. */
interface PlanEventMirror {
  type: string;
  deliveryId: string;
  businessId: string;
  routeId: string | null;
  reportedById: string | null;
  note: string | null;
  latitude?: number | null;
  longitude?: number | null;
  occurred_at?: Date | null;
  created_at: Date;
}

class InMemoryRouteRepository implements IRouteRepository {
  public routes: Route[] = [];
  public stops: RouteStop[] = [];

  /**
   * The delivery_event rows: the ROUTE_ADDED/ROUTE_REMOVED lines the plan
   * writes leave, and the ARRIVAL/PROOF points a test seeds for the map.
   */
  public events: PlanEventMirror[] = [];

  /** The shipper rows, for the picker's names (the real one joins them). */
  public shippers: Array<{ id: string; name: string; businessId: string }> = [];

  /**
   * The delivery rows this repository mirrors onto. Tests seed it so the
   * mirroring is observable — it is an invariant of the module, not a detail.
   *
   * A test that also drives the delivery use cases passes the delivery fake's
   * own array here, so both see one set of rows. In Postgres they always do.
   */
  constructor(
    public deliveries: DeliveryMirror[] = [],
    /**
     * The vehicle rows, for the one column this module owns on them. A test
     * that cares about it hands over the vehicle fake's own array.
     */
    public vehicles: VehicleMirror[] = [],
    /** The driver rows, for the assignment preview's names and statuses. */
    public drivers: DriverMirror[] = [],
  ) {}

  /**
   * Business.timezone per company, as the table would answer it. Unset reads
   * as the default zone, like a row with no (or an unknown) zone.
   */
  public timeZones: Record<string, string> = {};

  /**
   * The companies whose FLEET module is hired and on (BusinessEntitlement).
   * Absent reads as off, like a company with no row for it.
   */
  public fleetEnabled: Set<string> = new Set();

  /**
   * findDriverRoute's order for two candidates of the same status: the
   * oldest day, then the oldest row, then the id — a total order, as in the
   * real query, so both repositories answer the same route on a tie.
   */
  private runningOrder(a: Route, b: Route): number {
    return (
      a.scheduled_date.getTime() - b.scheduled_date.getTime() ||
      a.created_at.getTime() - b.created_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }

  private firstRunning(
    businessId: string,
    driverId: string,
    status: RouteStatus,
  ): Route | undefined {
    return this.routes
      .filter(
        (entry) =>
          entry.businessId === businessId &&
          entry.driverId === driverId &&
          entry.status === status,
      )
      .sort((a, b) => this.runningOrder(a, b))[0];
  }

  /**
   * IN_ROUTE is a fact about a route, so the route writes it and nothing else
   * does. Both moves are conditional exactly as the real `updateMany` is: the
   * departure only takes ACTIVE, the return only gives back IN_ROUTE — so a
   * vehicle an administrator blocked while it was on the road stays blocked.
   */
  private syncVehicleStatus(route: Route): void {
    if (!route.vehicleId) return;

    const vehicle = this.vehicles.find(
      (entry) =>
        entry.id === route.vehicleId && entry.businessId === route.businessId,
    );

    if (!vehicle) return;

    if (route.status === "IN_PROGRESS" && vehicle.status === "ACTIVE") {
      vehicle.status = "IN_ROUTE";

      return;
    }

    const ending = route.status === "COMPLETED" || route.status === "CANCELLED";

    // Only a route that left gives the truck back, as the real one does.
    if (ending && route.started_at && vehicle.status === "IN_ROUTE") {
      vehicle.status = "ACTIVE";
    }
  }

  /** The shadow cleared: back to the unassigned pool, off the driver's phone. */
  private releaseMirror(deliveryId: string, businessId: string): void {
    const delivery = this.deliveries.find(
      (entry) => entry.id === deliveryId && entry.businessId === businessId,
    );

    if (delivery) {
      delivery.driverId = null;
      delivery.vehicleId = null;
    }
  }

  private stopsOf(routeId: string): RouteStop[] {
    return this.stops
      .filter((stop) => stop.routeId === routeId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Mirrors `where: { id, businessId }` — wrong tenant reads as absent. */
  private routeOf(routeId: string, businessId: string): Route | undefined {
    return this.routes.find(
      (route) => route.id === routeId && route.businessId === businessId,
    );
  }

  /** R1, as the partial unique index states it. */
  private assertDeliveriesFree(deliveryIds: string[]): void {
    const taken = deliveryIds.filter((deliveryId) =>
      this.stops.some(
        (stop) => stop.deliveryId === deliveryId && isStopOpen(stop.status),
      ),
    );

    if (taken.length > 0) {
      throw new DeliveryAlreadyOnRouteError(taken.length);
    }
  }

  /**
   * The real repository mirrors the route onto its deliveries with
   * `status: "PENDING"` in the `where` and refuses a short count: a delivery
   * cancelled after the use case checked it must not become an open stop.
   * The count is `id IN (...) AND businessId AND status = PENDING`, so
   * another company's delivery is short exactly like a moved one. (A row with
   * no status set reads as PENDING, the column default.)
   */
  private assertDeliveriesStillPending(
    deliveryIds: string[],
    businessId: string,
  ): void {
    const moved = deliveryIds.some((deliveryId) => {
      const delivery = this.deliveries.find(
        (entry) => entry.id === deliveryId && entry.businessId === businessId,
      );

      return !delivery || (delivery.status ?? "PENDING") !== "PENDING";
    });

    if (moved) throw new DeliveryNoLongerRoutableError();
  }

  /**
   * What inserting open stops for `deliveryIds` and mirroring the route onto
   * them refuses in Postgres, in the same order (createRoute and addStops):
   *
   * - a delivery already on an open stop, or the same id twice in the call:
   *   the partial unique index, reported as DeliveryAlreadyOnRouteError (the
   *   duplicate used to become two stops here);
   * - an id with no delivery row at all: the foreign key, P2003;
   * - another company's delivery or one no longer PENDING: the mirror's short
   *   count, DeliveryNoLongerRoutableError (unknown and foreign ids used to
   *   pass silently).
   */
  private assertStopsInsertable(deliveryIds: string[], businessId: string): void {
    this.assertDeliveriesFree(deliveryIds);

    if (new Set(deliveryIds).size !== deliveryIds.length) {
      throw new DeliveryAlreadyOnRouteError(deliveryIds.length);
    }

    if (deliveryIds.some((deliveryId) => !this.deliveries.some((entry) => entry.id === deliveryId))) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated on the constraint: `route_stop_deliveryId_fkey`",
        { code: "P2003", clientVersion: "in-memory", meta: { field_name: "route_stop_deliveryId_fkey (index)" } },
      );
    }

    this.assertDeliveriesStillPending(deliveryIds, businessId);
  }

  /** R6, as the partial unique index states it. */
  private assertVehicleFree(routeId: string, vehicleId: string | null): void {
    if (!vehicleId) return;

    const busy = this.routes.some(
      (route) =>
        route.id !== routeId &&
        route.vehicleId === vehicleId &&
        route.status === "IN_PROGRESS",
    );

    if (busy) throw new RouteVehicleBusyError();
  }

  /** The mirrored driver's name, only from the same company (null if absent). */
  private driverName(businessId: string, driverId: string): string | null {
    return (
      this.drivers.find(
        (entry) => entry.id === driverId && entry.businessId === businessId,
      )?.name ?? null
    );
  }

  /** The mirrored vehicle's plate, only from the same company (null if absent). */
  private vehiclePlate(
    businessId: string,
    vehicleId: string | null,
  ): string | null {
    if (!vehicleId) return null;

    return (
      this.vehicles.find(
        (entry) => entry.id === vehicleId && entry.businessId === businessId,
      )?.license_plate ?? null
    );
  }

  private hydrate(route: Route): RouteWithStops {
    return {
      ...route,
      // The real include always has a driver and a plate; a test that did
      // not mirror the rows gets placeholders, never another tenant's name.
      driver: {
        id: route.driverId,
        name: this.driverName(route.businessId, route.driverId) ?? "Motorista",
      },
      vehicle: route.vehicleId
        ? {
            id: route.vehicleId,
            license_plate:
              this.vehiclePlate(route.businessId, route.vehicleId) ?? "ABC1D23",
          }
        : null,
      stops: this.stopsOf(route.id).map((stop) => {
        const delivery = this.deliveries.find(
          (entry) => entry.id === stop.deliveryId,
        );

        return {
          ...stop,
          delivery: {
            id: stop.deliveryId,
            kind: delivery?.kind ?? "DELIVERY",
            status: delivery?.status ?? "PENDING",
            recipient_name: delivery?.recipient_name ?? "Destinatário",

            recipient_email: delivery?.recipient_email ?? null,
            recipient_telephone: delivery?.recipient_telephone ?? null,

            invoice_number: delivery?.invoice_number ?? null,
            code: delivery?.code ?? null,
            invoice_key: delivery?.invoice_key ?? null,

            scheduled_date: delivery?.scheduled_date ?? null,
            businessId: delivery?.businessId,

            city: delivery?.city ?? "São Paulo",
            uf: delivery?.uf ?? "SP",
            street: delivery?.street ?? "Rua das Entregas",
            address_number: null,
            neighborhood: null,

            latitude: delivery?.latitude ?? null,
            longitude: delivery?.longitude ?? null,
            geo_source: delivery?.geo_source ?? null,
          },
        } as RouteStopWithDelivery;
      }),
    };
  }

  private mirror(route: Route): void {
    const ending = route.status === "COMPLETED" || route.status === "CANCELLED";

    const open = this.stopsOf(route.id).filter((stop) =>
      isStopOpen(stop.status),
    );

    if (open.length === 0) return;

    if (ending) {
      for (const stop of open) stop.status = "CANCELLED";
    }

    for (const stop of open) {
      // Scoped exactly like the real `updateMany`: the mirror never reaches a
      // row of another company, even with a crafted id.
      const delivery = this.deliveries.find(
        (entry) =>
          entry.id === stop.deliveryId && entry.businessId === route.businessId,
      );

      if (!delivery) continue;

      delivery.driverId = ending ? null : route.driverId;
      delivery.vehicleId = ending ? null : route.vehicleId;

      if (ending) {
        // The load that left and never arrived goes back to the pool.
        if (delivery.status === "IN_TRANSIT") delivery.status = "PENDING";

        continue;
      }

      // The departure puts the load on the street, in the same act as the
      // route leaving. Only PENDING moves — an outcome already recorded stands.
      if (route.status === "IN_PROGRESS" && delivery.status === "PENDING") {
        delivery.status = "IN_TRANSIT";
      }
    }
  }

  async createRoute(
    data: CreateRouteProps,

    // Accepted and ignored: there is no transaction to join here.
    _outerTx?: Prisma.TransactionClient,
  ): Promise<RouteWithStops> {
    // The (businessId, client_submission_id) unique index, as Postgres
    // raises it: a replay that lost the race reads as P2002 to the caller.
    if (
      data.client_submission_id &&
      this.routes.some(
        (route) =>
          route.businessId === data.businessId &&
          route.client_submission_id === data.client_submission_id,
      )
    ) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`businessId`,`client_submission_id`)",
        {
          code: "P2002",
          clientVersion: "in-memory",
          meta: { target: ["businessId", "client_submission_id"] },
        },
      );
    }

    this.assertStopsInsertable(data.deliveryIds, data.businessId);

    const highest = this.routes
      .filter((route) => route.businessId === data.businessId)
      .reduce((max, route) => Math.max(max, route.code), 0);

    const now = new Date();

    const route: Route = {
      ...ROUTE_COLUMN_DEFAULTS,
      id: uuidV7(),
      code: highest + 1,
      name: data.name ?? null,
      status: "PLANNED",
      // A `date` column: the table keeps the UTC day (decision 1.3).
      scheduled_date: asDateColumn(data.scheduled_date),
      destination: data.destination ?? null,
      planned_departure_at: data.planned_departure_at ?? null,
      planned_arrival_at: data.planned_arrival_at ?? null,
      started_at: null,
      completed_at: null,
      cancellation_reason: null,
      businessId: data.businessId,
      driverId: data.driverId,
      vehicleId: data.vehicleId ?? null,
      importId: data.importId ?? null,
      client_submission_id: data.client_submission_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.routes.push(route);

    data.deliveryIds.forEach((deliveryId, index) => {
      this.stops.push({
        ...ROUTE_STOP_COLUMN_DEFAULTS,
        id: uuidV7(),
        sequence: (index + 1) * 10,
        status: "PENDING",
        arrived_at: null,
        completed_at: null,
        routeId: route.id,
        deliveryId,
        created_at: now,
        updated_at: now,
      });

      // Scoped, like the real `updateMany`: the mirror never reaches a row of
      // another company even if a bad id slipped past the use case.
      const delivery = this.deliveries.find(
        (entry) => entry.id === deliveryId && entry.businessId === data.businessId,
      );

      if (delivery) {
        delivery.driverId = data.driverId;
        delivery.vehicleId = data.vehicleId ?? null;
      }
    });

    return this.hydrate(route);
  }

  /**
   * The same rule the real repository enforces, over the fixture rows.
   *
   * Written as its own check rather than by calling `removeStop` in a loop: a
   * fake that answered by looping would report a partial detach as success,
   * which is exactly the behaviour the real one refuses.
   */
  async detachFromOpenRoutes(
    deliveryIds: string[],
    businessId: string,

    // Accepted and ignored: there is no transaction to join here.
    _tx?: Prisma.TransactionClient,
  ): Promise<DetachResult> {
    if (deliveryIds.length === 0) {
      return { detached: 0, blocked: [], emptiedRoutes: [], bumped: [] };
    }

    const open = this.stops.filter((stop) => {
      if (!deliveryIds.includes(stop.deliveryId)) return false;
      if (!OPEN_STOP_STATUSES.includes(stop.status)) return false;

      const route = this.routes.find((entry) => entry.id === stop.routeId);

      return Boolean(route && route.businessId === businessId);
    });

    if (open.length === 0) {
      return { detached: 0, blocked: [], emptiedRoutes: [], bumped: [] };
    }

    const blocked = open
      .filter((stop) => {
        const route = this.routes.find((entry) => entry.id === stop.routeId);

        return !route || !EDITABLE_STATUSES.includes(route.status);
      })
      .map((stop) => {
        const delivery = this.deliveries.find(
          (entry) => entry.id === stop.deliveryId,
        );

        return delivery?.code ?? delivery?.recipient_name ?? stop.deliveryId;
      });

    if (blocked.length > 0) {
      return { detached: 0, blocked, emptiedRoutes: [], bumped: [] };
    }

    for (const stop of open) {
      // Spliced, not reassigned: a test may hold this exact array as the
      // delivery fake's view of the stops (see removeStop).
      this.stops.splice(this.stops.indexOf(stop), 1);

      const delivery = this.deliveries.find(
        (entry) => entry.id === stop.deliveryId && entry.businessId === businessId,
      );

      if (delivery) {
        delivery.driverId = null;
        delivery.vehicleId = null;
      }
    }

    const affected = [...new Set(open.map((stop) => stop.routeId))];

    // Every route that lost a stop has a new plan, as the real one bumps it.
    const bumped = await this.bumpPlanVersions(affected, businessId, _tx!);

    return {
      detached: open.length,
      blocked: [],
      bumped,
      emptiedRoutes: affected
        .filter((routeId) => !this.stops.some((stop) => stop.routeId === routeId))
        .map((routeId) => this.routeOf(routeId, businessId))
        .filter((route): route is Route => route !== undefined),
    };
  }

  async inspectOpenStops(
    deliveryIds: string[],
    businessId: string,
  ): Promise<{ holder: Route | null; blocked: string[] }> {
    const wanted = new Set(deliveryIds);

    if (wanted.size === 0) return { holder: null, blocked: [] };

    const held = this.stops.filter(
      (stop) =>
        wanted.has(stop.deliveryId) &&
        OPEN_STOP_STATUSES.includes(stop.status) &&
        this.routeOf(stop.routeId, businessId) !== undefined,
    );

    const blocked = held
      .filter(
        (stop) =>
          !EDITABLE_STATUSES.includes(this.routeOf(stop.routeId, businessId)!.status),
      )
      .map((stop) => {
        const delivery = this.deliveries.find(
          (entry) => entry.id === stop.deliveryId,
        );

        return delivery?.code ?? delivery?.recipient_name ?? stop.deliveryId;
      });

    const routeIds = new Set(held.map((stop) => stop.routeId));

    if (held.length !== wanted.size || routeIds.size !== 1) {
      return { holder: null, blocked };
    }

    const [routeId] = routeIds;

    const open = this.stops.filter(
      (stop) =>
        stop.routeId === routeId && OPEN_STOP_STATUSES.includes(stop.status),
    ).length;

    if (open !== wanted.size) return { holder: null, blocked };

    return { holder: this.routeOf(routeId, businessId) ?? null, blocked };
  }

  async updateRoute(
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,

    // Accepted and ignored: there is no transaction to join here.
    _tx?: Prisma.TransactionClient,
    options: PlanWriteOptions = {},
  ): Promise<Route> {
    const route = this.routeOf(routeId, businessId);

    if (!route || !EDITABLE_STATUSES.includes(route.status)) {
      throw new RouteStatusConflictError();
    }

    assertPlanVersion(route.plan_version, options.expectedPlanVersion);

    route.plan_version += 1;

    Object.assign(route, {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.scheduled_date !== undefined && {
        scheduled_date: asDateColumn(data.scheduled_date),
      }),
      ...(data.destination !== undefined && { destination: data.destination }),
      ...(data.planned_departure_at !== undefined && {
        planned_departure_at: data.planned_departure_at,
      }),
      ...(data.planned_arrival_at !== undefined && {
        planned_arrival_at: data.planned_arrival_at,
      }),
      ...(data.driverId !== undefined && { driverId: data.driverId }),
      ...(data.vehicleId !== undefined && { vehicleId: data.vehicleId }),
      updated_at: new Date(),
    });

    this.mirror(route);

    return route;
  }

  async findRouteById(
    routeId: string,
    businessId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<RouteWithStops | null> {
    const route = this.routeOf(routeId, businessId);

    return route ? this.hydrate(route) : null;
  }

  async findDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<RouteWithStops | null> {
    // In progress wins, then the real query's order within a status.
    const route =
      this.firstRunning(businessId, driverId, "IN_PROGRESS") ??
      this.firstRunning(businessId, driverId, "RELEASED");

    return route ? this.hydrate(route) : null;
  }

  async findActiveRouteForDriver(
    businessId: string,
    driverId: string,
  ): Promise<{ id: string; started_at: Date | null } | null> {
    const route = this.firstRunning(businessId, driverId, "IN_PROGRESS");

    return route
      ? { id: route.id, started_at: route.started_at ?? null }
      : null;
  }

  async businessTimeZone(businessId: string): Promise<string> {
    return resolveTimeZone(this.timeZones[businessId]);
  }

  async assignmentContext(businessId: string): Promise<AssignmentContext> {
    return {
      timeZone: resolveTimeZone(this.timeZones[businessId]),
      fleetEnabled: this.fleetEnabled.has(businessId),
    };
  }

  async lockDriverStatus(
    driverId: string,
    businessId: string,
    _tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    // Nothing to lock in memory; the row as the real read returns it.
    return (
      this.drivers.find(
        (entry) => entry.id === driverId && entry.businessId === businessId,
      )?.status ?? null
    );
  }

  async assertDriverFreeToDepart(
    driverId: string,
    businessId: string,
    routeId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<void> {
    // Nothing to lock in memory; the same read the real one makes under it.
    const running = this.routes
      .filter(
        (entry) =>
          entry.businessId === businessId &&
          entry.driverId === driverId &&
          entry.status === "IN_PROGRESS" &&
          entry.id !== routeId,
      )
      .sort((a, b) => this.runningOrder(a, b))[0];

    if (running) throw new RouteDriverBusyError(running.code);
  }

  async assignmentPreview({
    businessId,
    driverId,
    vehicleId,
    day,
    deliveryIds = [],
    fleetFacts,
  }: AssignmentPreviewProps): Promise<AssignmentPreview> {
    const dayTime = asDateColumn(day).getTime();

    // The placeholder hydrate() uses when the driver row is not mirrored:
    // the real relation always has a name.
    const nameOf = (id: string): string =>
      this.driverName(businessId, id) ?? "Motorista";

    const toRef = (route: Route): AssignmentRouteRef => ({
      id: route.id,
      code: route.code,
      status: route.status,
      driverName: nameOf(route.driverId),
    });

    const ofTenant = this.routes.filter((route) => route.businessId === businessId);

    const onDay = (route: Route): boolean =>
      asDateColumn(route.scheduled_date).getTime() === dayTime &&
      EDITABLE_STATUSES.includes(route.status);

    const byCode = (a: Route, b: Route): number => a.code - b.code;

    const driver = this.drivers.find(
      (entry) => entry.id === driverId && entry.businessId === businessId,
    );

    const vehicle = vehicleId
      ? this.vehicles.find(
          (entry) => entry.id === vehicleId && entry.businessId === businessId,
        )
      : undefined;

    const driverRow = driver
      ? {
          id: driverId,
          name: driver.name ?? "Motorista",
          status: driver.status ?? "ACTIVE",
          cnh_category: driver.cnh_category ?? null,
          cnh_expires_at: driver.cnh_expires_at
            ? asDateColumn(driver.cnh_expires_at)
            : null,
        }
      : null;

    // As the real read: a driver or vehicle not of the company ends it.
    if (!driverRow || (vehicleId && !vehicle)) {
      return {
        driver: driverRow,
        driverRunningRoute: null,
        driverRoutesOnDay: [],
        responsibleVehicles: [],
        vehicle: null,
        vehicleRunningRoute: null,
        vehicleRoutesOnDay: [],
        routesEmptiedBySelection: [],
      };
    }

    const responsibleName = vehicle?.driverId ? nameOf(vehicle.driverId) : null;

    const vehicleRunning = vehicleId
      ? ofTenant
          .filter(
            (route) =>
              route.vehicleId === vehicleId && route.status === "IN_PROGRESS",
          )
          .sort((a, b) => this.runningOrder(a, b))[0]
      : undefined;

    const driverRunning = this.firstRunning(businessId, driverId, "IN_PROGRESS");

    // RELEASED routes whose open stops are all in the selection, as the real
    // query decides it.
    const selected = new Set(deliveryIds);

    const routesEmptiedBySelection = ofTenant
      .filter((route) => {
        if (route.status !== "RELEASED") return false;

        const open = this.stopsOf(route.id).filter((stop) =>
          OPEN_STOP_STATUSES.includes(stop.status),
        );

        return (
          open.length > 0 && open.every((stop) => selected.has(stop.deliveryId))
        );
      })
      .map((route) => route.id)
      .sort();

    return {
      driver: driverRow,
      driverRunningRoute: driverRunning ? toRef(driverRunning) : null,
      driverRoutesOnDay: ofTenant
        .filter((route) => route.driverId === driverId && onDay(route))
        .sort(byCode)
        .slice(0, PREVIEW_LIMIT)
        .map(toRef),
      // Newest first, as the real query orders them.
      responsibleVehicles: this.vehicles
        .filter(
          (entry) =>
            entry.businessId === businessId &&
            entry.driverId === driverId &&
            (entry.status === "ACTIVE" || entry.status === "IN_ROUTE"),
        )
        .sort(
          (a, b) =>
            (b.created_at ? new Date(b.created_at).getTime() : 0) -
              (a.created_at ? new Date(a.created_at).getTime() : 0) ||
            ((b.id ?? "") < (a.id ?? "") ? -1 : (b.id ?? "") > (a.id ?? "") ? 1 : 0),
        )
        .slice(0, PREVIEW_LIMIT)
        .map((entry) => ({
          id: entry.id!,
          license_plate: entry.license_plate ?? "",
          description: entry.description ?? null,
          status: entry.status ?? "ACTIVE",
        })),
      vehicle: vehicle
        ? {
            id: vehicle.id!,
            license_plate: vehicle.license_plate ?? "",
            description: vehicle.description ?? null,
            status: vehicle.status ?? "ACTIVE",
            responsible:
              vehicle.driverId && responsibleName !== null
                ? { id: vehicle.driverId, name: responsibleName }
                : null,
            required_cnh_category: vehicle.required_cnh_category ?? null,
            // Not read for a company without FLEET, as the real query.
            openServiceOrders: fleetFacts
              ? {
                  count: vehicle.open_service_orders?.length ?? 0,
                  oldest:
                    [...(vehicle.open_service_orders ?? [])].sort(
                      (a, b) => a.getTime() - b.getTime(),
                    )[0] ?? null,
                }
              : null,
            lastChecklist: fleetFacts ? (vehicle.last_checklist ?? null) : null,
          }
        : null,
      vehicleRunningRoute: vehicleRunning ? toRef(vehicleRunning) : null,
      vehicleRoutesOnDay: vehicleId
        ? ofTenant
            .filter((route) => route.vehicleId === vehicleId && onDay(route))
            .sort(byCode)
            .slice(0, PREVIEW_LIMIT)
            .map(toRef)
        : [],
      routesEmptiedBySelection,
    };
  }

  async listRoutes({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListRoutesProps): Promise<ListRoutesResult> {
    // The Prisma query's filters (routeListWhere). On a `date` column an
    // instant matches its whole UTC day, so days are compared, not instants.
    const day = filters.scheduled_date
      ? asDateColumn(filters.scheduled_date).getTime()
      : null;
    const term = filters.search?.trim().toLowerCase() ?? "";
    // The same reading of a code the real query makes (TEST-ROUTE-1).
    const code = routeCodeFromSearch(term);

    // Only a mirrored driver has a name to match, as only a real driver row
    // has one in Postgres: the display placeholder must never match a search.
    const matchesSearch = (route: Route): boolean =>
      (route.name ?? "").toLowerCase().includes(term) ||
      (route.destination ?? "").toLowerCase().includes(term) ||
      (this.driverName(route.businessId, route.driverId) ?? "")
        .toLowerCase()
        .includes(term) ||
      route.code === code;

    const matches = (route: Route, except?: RouteFacet): boolean =>
      route.businessId === filters.businessId &&
      (!filters.scopeDriverId || route.driverId === filters.scopeDriverId) &&
      (day === null || asDateColumn(route.scheduled_date).getTime() === day) &&
      (except === "status" ||
        !filters.statuses?.length ||
        filters.statuses.includes(route.status)) &&
      (except === "driverId" ||
        !filters.driverIds?.length ||
        filters.driverIds.includes(route.driverId)) &&
      (except === "vehicleId" ||
        !filters.vehicleIds?.length ||
        (route.vehicleId !== null && filters.vehicleIds.includes(route.vehicleId))) &&
      (!term || matchesSearch(route));

    // resolveOrderBy's choice, compared the way Postgres orders: NULL
    // placement per key, then created_at desc, id desc as the tiebreaker.
    const key = sort ?? ROUTE_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : ROUTE_SORT_FALLBACK.order);

    const valueOf: Record<RouteSortKey, (route: Route) => OrderValue> = {
      created_at: (route) => route.created_at,
      updated_at: (route) => route.updated_at,
      code: (route) => route.code,
      status: (route) => ROUTE_LIST_STATUSES.indexOf(route.status),
      driverName: (route) => this.driverName(route.businessId, route.driverId),
      vehiclePlate: (route) => this.vehiclePlate(route.businessId, route.vehicleId),
      scheduled_date: (route) => route.scheduled_date,
      destination: (route) => route.destination,
      started_at: (route) => route.started_at,
      completed_at: (route) => route.completed_at,
    };

    // `{ sort, nulls: "last" }` columns; the rest follow Postgres' default.
    const nulls: Partial<Record<RouteSortKey, NullsPlacement>> = {
      destination: "last",
      started_at: "last",
      completed_at: "last",
    };

    const filtered = this.routes
      .filter((route) => matches(route))
      .sort(
        (a, b) =>
          compareForOrder(valueOf[key](a), valueOf[key](b), direction, nulls[key]) ||
          compareForOrder(a.created_at, b.created_at, "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const countBy = (
      except: RouteFacet,
      pick: (route: Route) => string | null,
    ): GroupCount[] => {
      const tally = new Map<string | null, number>();

      for (const route of this.routes.filter((entry) => matches(entry, except))) {
        tally.set(pick(route), (tally.get(pick(route)) ?? 0) + 1);
      }

      return [...tally].map(([value, count]) => ({ value, count }));
    };

    const byDriver = countBy("driverId", (route) => route.driverId);
    const byVehicle = countBy("vehicleId", (route) => route.vehicleId);

    // Names only from the company's own rows, like the Prisma lookup.
    const labels = (
      groups: GroupCount[],
      selected: string[] | undefined,
      nameOf: (id: string) => string | null | undefined,
    ): Map<string, string> =>
      new Map(
        [...new Set([...groups.map((group) => group.value), ...(selected ?? [])])]
          .filter((id): id is string => typeof id === "string")
          .flatMap((id) => {
            const name = nameOf(id);

            return name ? [[id, name] as const] : [];
          }),
      );

    const { total, searchMeta } = summarizeRouteList(
      countBy("status", (route) => route.status),
      filters,
      {
        drivers: catalogFacetOptions(
          byDriver,
          filters.driverIds,
          labels(byDriver, filters.driverIds, (id) =>
            this.driverName(filters.businessId, id),
          ),
        ),
        vehicles: catalogFacetOptions(
          byVehicle,
          filters.vehicleIds,
          labels(byVehicle, filters.vehicleIds, (id) =>
            this.vehiclePlate(filters.businessId, id),
          ),
        ),
      },
    );

    return {
      data: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map((route) => this.hydrate(route)),
      total,
      meta: searchMeta,
    };
  }

  async transitionRoute(
    routeId: string,
    businessId: string,
    transition: RouteTransition,
  ): Promise<Route> {
    const route = this.routeOf(routeId, businessId);

    // Mirrors `where: { id, businessId, status }`: wrong tenant and wrong
    // status are the same answer, because they are the same empty result set.
    if (!route || route.status !== transition.expectedStatus) {
      throw new RouteStatusConflictError();
    }

    const nextVehicleId =
      transition.vehicleId !== undefined
        ? transition.vehicleId
        : route.vehicleId;

    if (transition.status === "IN_PROGRESS") {
      this.assertVehicleFree(routeId, nextVehicleId);
    }

    route.status = transition.status;
    route.vehicleId = nextVehicleId;

    if (transition.started_at) route.started_at = transition.started_at;
    if (transition.completed_at) route.completed_at = transition.completed_at;

    if (transition.cancellation_reason) {
      route.cancellation_reason = transition.cancellation_reason;
    }

    // As the real write: handed over now, or a draft again.
    if (transition.status === "RELEASED") route.released_at = new Date();
    if (transition.status === "PLANNED") route.released_at = null;

    route.updated_at = new Date();

    this.mirror(route);
    this.syncVehicleStatus(route);

    return route;
  }

  /** lockEditableRoute's answer: null when gone, foreign or already left. */
  private editableRoute(routeId: string, businessId: string): Route | null {
    const route = this.routeOf(routeId, businessId);

    return route && EDITABLE_STATUSES.includes(route.status) ? route : null;
  }

  private planResult(route: Route) {
    return {
      planVersion: route.plan_version,
      status: route.status,
      driverId: route.driverId,
      code: route.code,
    };
  }

  async recordPlanEvents(
    _tx: Prisma.TransactionClient,
    rows: Array<{ deliveryId: string; note: string }>,
    meta: {
      type: "ROUTE_ADDED" | "ROUTE_REMOVED";
      routeId: string;
      businessId: string;
      actorId?: string | null;
    },
  ): Promise<void> {
    // Same gate as the real one (see PLANNING_TIMELINE_EVENTS_ENABLED).
    if (!PLANNING_TIMELINE_EVENTS_ENABLED) return;

    const now = new Date();

    for (const row of rows) {
      this.events.push({
        type: meta.type,
        deliveryId: row.deliveryId,
        businessId: meta.businessId,
        routeId: meta.routeId,
        reportedById: meta.actorId ?? null,
        note: row.note,
        created_at: now,
      });
    }
  }

  private pushPlanEvents(
    rows: Array<{ deliveryId: string; note: string }>,
    type: "ROUTE_ADDED" | "ROUTE_REMOVED",
    route: Route,
    actorId?: string | null,
  ): void {
    if (!PLANNING_TIMELINE_EVENTS_ENABLED) return;

    const now = new Date();

    for (const row of rows) {
      this.events.push({
        type,
        deliveryId: row.deliveryId,
        businessId: route.businessId,
        routeId: route.id,
        reportedById: actorId ?? null,
        note: row.note,
        created_at: now,
      });
    }
  }

  async addStops(
    routeId: string,
    businessId: string,
    deliveryIds: string[],
    _outerTx?: Prisma.TransactionClient,
    options: PlanWriteOptions = {},
  ): Promise<PlanStopsAdded> {
    const route = this.editableRoute(routeId, businessId);

    if (!route) throw new RouteStatusConflictError();

    assertPlanVersion(route.plan_version, options.expectedPlanVersion);

    const open = this.stopsOf(routeId).filter((stop) =>
      isStopOpen(stop.status),
    ).length;

    if (open + deliveryIds.length > ROUTE_MAX_STOPS) {
      throw new RouteStopsLimitError(ROUTE_MAX_STOPS);
    }

    this.assertStopsInsertable(deliveryIds, businessId);

    const existing = this.stopsOf(routeId);

    let sequence = existing.length
      ? Math.max(...existing.map((stop) => stop.sequence))
      : null;

    const created: RouteStop[] = [];
    const now = new Date();

    for (const deliveryId of deliveryIds) {
      sequence = nextSequence(sequence);

      const stop: RouteStop = {
        ...ROUTE_STOP_COLUMN_DEFAULTS,
        id: uuidV7(),
        sequence,
        status: "PENDING",
        arrived_at: null,
        completed_at: null,
        routeId,
        deliveryId,
        created_at: now,
        updated_at: now,
      };

      this.stops.push(stop);
      created.push(stop);

      const delivery = this.deliveries.find(
        (entry) => entry.id === deliveryId && entry.businessId === businessId,
      );

      if (delivery) {
        delivery.driverId = route.driverId;
        delivery.vehicleId = route.vehicleId;
      }
    }

    route.plan_version += 1;

    this.pushPlanEvents(
      deliveryIds.map((deliveryId, index) => ({
        deliveryId,
        note: `Adicionada à Rota ${route.code} (parada ${open + index + 1}).`,
      })),
      "ROUTE_ADDED",
      route,
      options.actorId,
    );

    return { stops: created, ...this.planResult(route) };
  }

  async removeStops(
    routeId: string,
    businessId: string,
    stopIds: string[],
    options: PlanWriteOptions = {},
  ): Promise<PlanStopsRemoved> {
    const route = this.editableRoute(routeId, businessId);

    if (!route) throw new RouteStatusConflictError();

    assertPlanVersion(route.plan_version, options.expectedPlanVersion);

    const wanted = [...new Set(stopIds)];

    const stops = this.stops.filter(
      (stop) =>
        wanted.includes(stop.id) &&
        stop.routeId === routeId &&
        stop.status === "PENDING",
    );

    const found = new Set(stops.map((stop) => stop.id));
    const alreadyGone = wanted.filter((id) => !found.has(id));

    if (stops.length === 0) {
      return {
        ...this.planResult(route),
        removed: [],
        alreadyGone,
        routeEmptied: false,
      };
    }

    for (const stop of stops) {
      // Spliced, not reassigned: a test may be holding this exact array as
      // the delivery fake's view of the stops.
      this.stops.splice(this.stops.indexOf(stop), 1);
      this.releaseMirror(stop.deliveryId, businessId);
    }

    route.plan_version += 1;

    this.pushPlanEvents(
      stops.map((stop) => ({
        deliveryId: stop.deliveryId,
        note: `Retirada da Rota ${route.code} antes da saída.`,
      })),
      "ROUTE_REMOVED",
      route,
      options.actorId,
    );

    const remaining = this.stopsOf(routeId).filter((stop) =>
      isStopOpen(stop.status),
    ).length;

    return {
      ...this.planResult(route),
      removed: stops.map((stop) => ({
        stopId: stop.id,
        deliveryId: stop.deliveryId,
      })),
      alreadyGone,
      routeEmptied: remaining === 0,
    };
  }

  async reorderStops(
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
    options: PlanWriteOptions = {},
  ): Promise<PlanReordered> {
    const route = this.editableRoute(routeId, businessId);

    if (!route) throw new RouteStatusConflictError();

    assertPlanVersion(route.plan_version, options.expectedPlanVersion);

    const current = this.stopsOf(routeId);
    const currentIds = new Set(current.map((stop) => stop.id));
    const orderedIds = new Set(orderedStopIds);

    if (
      currentIds.size !== orderedIds.size ||
      orderedStopIds.some((id) => !currentIds.has(id))
    ) {
      throw new RouteReorderMismatchError();
    }

    if (current.every((stop, index) => stop.id === orderedStopIds[index])) {
      return { ...this.planResult(route), changed: false };
    }

    for (const { id, sequence } of resequence(orderedStopIds)) {
      const stop = this.stops.find((entry) => entry.id === id);
      if (stop) stop.sequence = sequence;
    }

    route.plan_version += 1;

    return { ...this.planResult(route), changed: true };
  }

  async lockRoutes(
    _routeIds: string[],
    _businessId: string,
    _tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Nothing to lock in memory: one test runs one write at a time.
  }

  async bumpPlanVersions(
    routeIds: string[],
    businessId: string,
    _tx: Prisma.TransactionClient,
  ): Promise<PlanBump[]> {
    return [...new Set(routeIds)]
      .sort()
      .map((routeId) => this.routeOf(routeId, businessId))
      .filter((route): route is Route => Boolean(route))
      .map((route) => {
        route.plan_version += 1;

        return { routeId: route.id, ...this.planResult(route) };
      });
  }

  async findRouteBySubmission(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<RouteWithStops | null> {
    const route = this.routes.find(
      (entry) =>
        entry.businessId === businessId &&
        entry.client_submission_id === clientSubmissionId,
    );

    return route ? this.hydrate(route) : null;
  }

  async pinDeliveryLocation(
    deliveryId: string,
    businessId: string,
    point: { latitude: number; longitude: number } | null,
  ): Promise<PinnedLocation | null> {
    const delivery = this.deliveries.find(
      (entry) => entry.id === deliveryId && entry.businessId === businessId,
    );

    if (!delivery) return null;

    if (delivery.status === "DELIVERED" || delivery.status === "CANCELLED") {
      return { locked: true, delivery: null, route: null };
    }

    delivery.latitude = point?.latitude ?? null;
    delivery.longitude = point?.longitude ?? null;
    delivery.geo_source = point ? "MANUAL" : null;
    delivery.geo_updated_at = new Date();

    const stop = this.stops.find(
      (entry) => entry.deliveryId === deliveryId && isStopOpen(entry.status),
    );

    const route = stop ? this.editableRoute(stop.routeId, businessId) : null;

    if (route) route.plan_version += 1;

    return {
      locked: false,
      delivery: {
        id: deliveryId,
        latitude: delivery.latitude,
        longitude: delivery.longitude,
        geo_source: delivery.geo_source,
        geo_updated_at: delivery.geo_updated_at,
      },
      route: route ? { routeId: route.id, ...this.planResult(route) } : null,
    };
  }

  async findOpenStopRoutes(
    deliveryIds: string[],
    businessId: string,
  ): Promise<OpenStopRoute[]> {
    const wanted = new Set(deliveryIds);

    return this.stops
      .filter((stop) => wanted.has(stop.deliveryId) && isStopOpen(stop.status))
      .map((stop) => ({ stop, route: this.routeOf(stop.routeId, businessId) }))
      .filter(
        (entry): entry is { stop: RouteStop; route: Route } =>
          entry.route !== undefined,
      )
      .map(({ stop, route }) => ({
        deliveryId: stop.deliveryId,
        stopId: stop.id,
        routeId: route.id,
        routeCode: route.code,
        routeStatus: route.status,
      }));
  }

  async listVisitedPoints(
    routeId: string,
    businessId: string,
  ): Promise<VisitedPoint[]> {
    return this.events
      .filter(
        (event) =>
          event.routeId === routeId &&
          event.businessId === businessId &&
          (event.type === "ARRIVAL" || event.type === "PROOF") &&
          event.latitude != null &&
          event.longitude != null,
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, 2 * ROUTE_MAX_STOPS)
      .map((event) => ({
        deliveryId: event.deliveryId,
        type: event.type as VisitedPoint["type"],
        latitude: event.latitude as number,
        longitude: event.longitude as number,
        recordedAt: event.occurred_at ?? event.created_at,
      }));
  }

  async listUnroutedDeliveries(
    query: UnroutedDeliveriesQuery,
  ): Promise<UnroutedDeliveriesPage> {
    const day = (value: Date | string | null | undefined): number | null =>
      value == null ? null : new Date(value).getTime();

    const matches = (
      delivery: DeliveryMirror,
      skip: UnroutedFacet | null,
    ): boolean => {
      if (delivery.businessId !== query.businessId) return false;
      if (delivery.status !== "PENDING") return false;

      if (
        this.stops.some(
          (stop) => stop.deliveryId === delivery.id && isStopOpen(stop.status),
        )
      ) {
        return false;
      }

      const search = query.search?.trim().toLowerCase();

      if (search) {
        const haystack = [
          delivery.code,
          delivery.invoice_number,
          delivery.recipient_name,
          delivery.city,
          delivery.street,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase());

        if (
          !haystack.some((value) => value.includes(search)) &&
          !(delivery.invoice_key ?? "").includes(query.search!.trim())
        ) {
          return false;
        }
      }

      if (
        skip !== "shipper" &&
        query.shipperIds?.length &&
        !query.shipperIds.includes(delivery.shipperId ?? "")
      ) {
        return false;
      }

      if (
        skip !== "city" &&
        query.cities?.length &&
        !query.cities.some(
          (city) => city.toLowerCase() === (delivery.city ?? "").toLowerCase(),
        )
      ) {
        return false;
      }

      if (
        skip !== "uf" &&
        query.ufs?.length &&
        !query.ufs.map((uf) => uf.toUpperCase()).includes(delivery.uf ?? "")
      ) {
        return false;
      }

      if (
        skip !== "kind" &&
        query.kinds?.length &&
        !query.kinds.includes((delivery.kind ?? "DELIVERY") as "DELIVERY")
      ) {
        return false;
      }

      const scheduled = day(delivery.scheduled_date);

      if (query.scheduledFrom || query.scheduledTo) {
        const inRange =
          scheduled !== null &&
          (!query.scheduledFrom || scheduled >= query.scheduledFrom.getTime()) &&
          (!query.scheduledTo || scheduled <= query.scheduledTo.getTime());

        if (!inRange && !(query.includeUnscheduled && scheduled === null)) {
          return false;
        }
      } else if (query.includeUnscheduled === false && scheduled === null) {
        return false;
      }

      return true;
    };

    const facet = (skip: UnroutedFacet, key: "city" | "uf" | "kind") => {
      const counts = new Map<string, number>();

      for (const delivery of this.deliveries) {
        if (!matches(delivery, skip)) continue;

        const value =
          key === "kind" ? (delivery.kind ?? "DELIVERY") : (delivery[key] ?? "");

        counts.set(value, (counts.get(value) ?? 0) + 1);
      }

      return [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([value, count]) => ({ value, count }));
    };

    // Same as the real one: tenant-scoped names, cut and ordered alike.
    const shipperName = (id: string | undefined) =>
      this.shippers.find(
        (shipper) => shipper.id === id && shipper.businessId === query.businessId,
      )?.name;

    const shipperCounts = new Map<string, number>();

    for (const delivery of this.deliveries) {
      if (!delivery.shipperId || !matches(delivery, "shipper")) continue;

      shipperCounts.set(
        delivery.shipperId,
        (shipperCounts.get(delivery.shipperId) ?? 0) + 1,
      );
    }

    // The real ORDER BY: scheduled day ascending with no day last, then the
    // oldest row, then the id.
    const rows = this.deliveries
      .filter((delivery) => matches(delivery, null))
      .sort((a, b) => {
        const da = day(a.scheduled_date);
        const db = day(b.scheduled_date);

        if (da !== db) {
          if (da === null) return 1;
          if (db === null) return -1;

          return da - db;
        }

        const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
        const cb = b.created_at ? new Date(b.created_at).getTime() : 0;

        if (ca !== cb) return ca - cb;

        return (a.id ?? "") < (b.id ?? "") ? -1 : 1;
      });

    const page = rows.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    );

    return {
      data: page.map((delivery) => ({
        id: delivery.id!,
        code: delivery.code ?? null,
        kind: delivery.kind ?? "DELIVERY",
        invoice_number: delivery.invoice_number ?? null,
        recipient_name: delivery.recipient_name ?? "",
        street: delivery.street ?? "",
        address_number: null,
        neighborhood: null,
        city: delivery.city ?? "",
        uf: delivery.uf ?? "",
        scheduled_date:
          delivery.scheduled_date == null
            ? null
            : new Date(delivery.scheduled_date),
        latitude: delivery.latitude ?? null,
        longitude: delivery.longitude ?? null,
        // The relation as the real select reads it.
        shipper: (() => {
          const name = shipperName(delivery.shipperId);

          return name ? { id: delivery.shipperId!, name } : null;
        })(),
      })),
      total: rows.length,
      facets: {
        city: facet("city", "city"),
        uf: facet("uf", "uf"),
        kind: facet("kind", "kind"),
        shipper: orderShipperFacet(
          [...shipperCounts.entries()].map(([value, count]) => ({ value, count })),
          (id) => shipperName(id),
        ),
      },
    };
  }

  async listDepartedDeliveries(
    routeId: string,
    businessId: string,
  ): Promise<RouteStopWithDelivery["delivery"][]> {
    const route = this.routeOf(routeId, businessId);

    if (!route) return [];

    // Same match as the real query: open stops whose delivery is in transit.
    return this.hydrate(route)
      .stops.filter(
        (stop) => isStopOpen(stop.status) && stop.delivery.status === "IN_TRANSIT",
      )
      .map((stop) => stop.delivery);
  }

  async countRoutesReferencing(reference: {
    driverId?: string;
    vehicleId?: string;
  }): Promise<number> {
    return this.routes.filter(
      (route) =>
        (!reference.driverId || route.driverId === reference.driverId) &&
        (!reference.vehicleId || route.vehicleId === reference.vehicleId),
    ).length;
  }

  async findStopById(
    stopId: string,
    businessId: string,
  ): Promise<(RouteStop & { route: Route }) | null> {
    const stop = this.stops.find((entry) => entry.id === stopId);
    if (!stop) return null;

    const route = this.routeOf(stop.routeId, businessId);
    if (!route) return null;

    return { ...stop, route };
  }

  async lockRouteOfOpenStop(
    deliveryId: string,
    businessId: string,
  ): Promise<string | null> {
    // Nothing to lock in memory; the same match as the real query (a route
    // that is running or has not left yet).
    const stop = this.stops.find((entry) => {
      if (entry.deliveryId !== deliveryId) return false;
      if (!OPEN_STOP_STATUSES.includes(entry.status)) return false;

      const status = this.routeOf(entry.routeId, businessId)?.status;

      return status === "IN_PROGRESS" || EDITABLE_STATUSES.includes(status!);
    });

    return stop?.routeId ?? null;
  }

  async settleStopForDelivery(
    deliveryId: string,
    businessId: string,
    outcome: {
      from: RouteStopStatus[];
      status: RouteStopStatus;
      arrived_at?: Date;
      completed_at?: Date;
      releaseDelivery?: boolean;
      onPlanDropped?: (bump: PlanBump) => void;
    },
  ): Promise<{ stop: RouteStop; closedRoute: Route | null } | null> {
    // The real one takes a transaction client; there is nothing to join here,
    // and pretending otherwise would be the fake claiming a guarantee it does
    // not give. What IS mirrored is every condition of the `where`: the
    // tenant, the route being in progress, and the stop being in `from`.
    const stop = this.stops.find((entry) => {
      if (entry.deliveryId !== deliveryId) return false;
      if (!outcome.from.includes(entry.status)) return false;

      const route = this.routeOf(entry.routeId, businessId);

      return Boolean(route) && route!.status === "IN_PROGRESS";
    });

    // Nothing to settle is not an error: most deliveries are not on a route.
    // A delivery done with while still on a plan that has not left comes off
    // that plan, as the real repository's dropFromUnstartedRoute does it — a
    // terminal outcome only, never a return to pending (see settleWithin).
    if (!stop) {
      if (outcome.status !== "ARRIVED" && !outcome.releaseDelivery) {
        const planned = this.stops.find(
          (entry) =>
            entry.deliveryId === deliveryId &&
            OPEN_STOP_STATUSES.includes(entry.status) &&
            EDITABLE_STATUSES.includes(
              this.routeOf(entry.routeId, businessId)?.status as RouteStatus,
            ),
        );

        if (planned) {
          this.stops.splice(this.stops.indexOf(planned), 1);
          this.releaseMirror(deliveryId, businessId);

          // The plan moved a version, as the real one bumps it.
          const route = this.routeOf(planned.routeId, businessId)!;

          route.plan_version += 1;
          this.pushPlanEvents(
            [{ deliveryId, note: `Retirada da Rota ${route.code}: a entrega foi encerrada.` }],
            "ROUTE_REMOVED",
            route,
            null,
          );
          outcome.onPlanDropped?.({ routeId: route.id, ...this.planResult(route) });
        }
      }

      return null;
    }

    stop.status = outcome.status;
    if (outcome.arrived_at) stop.arrived_at = outcome.arrived_at;
    if (outcome.completed_at) stop.completed_at = outcome.completed_at;
    stop.updated_at = new Date();

    // Back to the pool with the stop, as the real one does it.
    if (outcome.releaseDelivery) this.releaseMirror(deliveryId, businessId);

    const route = this.routeOf(stop.routeId, businessId)!;

    const stillOpen = this.stopsOf(route.id).some((entry) =>
      isStopOpen(entry.status),
    );

    if (stillOpen) return { stop, closedRoute: null };

    // By the time of the facts, as the real closeIfFinished dates it.
    const resolvedAt = this.stopsOf(route.id)
      .map((entry) => (entry.completed_at ?? entry.updated_at)?.getTime())
      .filter((time): time is number => typeof time === "number");

    route.status = "COMPLETED";
    route.completed_at = routeCompletedAt({
      closingAt: outcome.completed_at,
      lastResolvedAt:
        resolvedAt.length > 0 ? new Date(Math.max(...resolvedAt)) : null,
      startedAt: route.started_at,
      now: new Date(),
    });
    route.updated_at = new Date();

    // The route ended by itself, so the truck came back by itself too.
    this.syncVehicleStatus(route);

    return { stop, closedRoute: route };
  }
}

export { InMemoryRouteRepository };
