import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import {
  isStopOpen,
  nextSequence,
  resequence,
} from "@/shared/route/route-rules";

import {
  DeliveryAlreadyOnRouteError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopNotFoundError,
  RouteVehicleBusyError,
} from "../../usecases/errors/route-errors";

import type { IRouteRepository } from "../IRoute-repository";
import type {
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  Route,
  RouteStop,
  RouteStopWithDelivery,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
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
const ROUTE_STATUSES: RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

const EDITABLE_STATUSES: RouteStatus[] = ["PLANNED", "RELEASED"];

/** Mirrors `route-rules`: a stop nobody has finished yet. */
const OPEN_STOP_STATUSES = ["PENDING", "ARRIVED"];

/**
 * The shape this repository needs from a delivery row. Deliberately a subset,
 * and every field optional that is optional on the real DTO, so a test can
 * hand over the delivery fake's OWN array instead of a copy — routes and
 * deliveries are one table in Postgres, and a test where they are two stores
 * can show a departure that moved nothing.
 */
/** What this repository needs from a vehicle row: the status it owns. */
interface VehicleMirror {
  id?: string;
  businessId: string;
  status?: string;
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

  scheduled_date?: Date | string | null;
}

class InMemoryRouteRepository implements IRouteRepository {
  public routes: Route[] = [];
  public stops: RouteStop[] = [];

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
  ) {}

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

    if (ending && vehicle.status === "IN_ROUTE") {
      vehicle.status = "ACTIVE";
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

  private hydrate(route: Route): RouteWithStops {
    return {
      ...route,
      driver: { id: route.driverId, name: "Motorista" },
      vehicle: route.vehicleId
        ? { id: route.vehicleId, license_plate: "ABC1D23" }
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

            scheduled_date: delivery?.scheduled_date ?? null,
            businessId: delivery?.businessId,

            city: "São Paulo",
            uf: "SP",
            street: "Rua das Entregas",
            address_number: null,
            neighborhood: null,
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
    this.assertDeliveriesFree(data.deliveryIds);

    const highest = this.routes
      .filter((route) => route.businessId === data.businessId)
      .reduce((max, route) => Math.max(max, route.code), 0);

    const now = new Date();

    const route: Route = {
      id: uuidV7(),
      code: highest + 1,
      name: data.name ?? null,
      status: "PLANNED",
      scheduled_date: data.scheduled_date,
      planned_departure_at: data.planned_departure_at ?? null,
      planned_arrival_at: data.planned_arrival_at ?? null,
      started_at: null,
      completed_at: null,
      cancellation_reason: null,
      businessId: data.businessId,
      driverId: data.driverId,
      vehicleId: data.vehicleId ?? null,
      importId: data.importId ?? null,
      created_at: now,
      updated_at: now,
    };

    this.routes.push(route);

    data.deliveryIds.forEach((deliveryId, index) => {
      this.stops.push({
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
  ): Promise<{ detached: number; blocked: string[] }> {
    if (deliveryIds.length === 0) return { detached: 0, blocked: [] };

    const open = this.stops.filter((stop) => {
      if (!deliveryIds.includes(stop.deliveryId)) return false;
      if (!OPEN_STOP_STATUSES.includes(stop.status)) return false;

      const route = this.routes.find((entry) => entry.id === stop.routeId);

      return Boolean(route && route.businessId === businessId);
    });

    if (open.length === 0) return { detached: 0, blocked: [] };

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

    if (blocked.length > 0) return { detached: 0, blocked };

    for (const stop of open) {
      this.stops = this.stops.filter((entry) => entry.id !== stop.id);

      const delivery = this.deliveries.find(
        (entry) => entry.id === stop.deliveryId && entry.businessId === businessId,
      );

      if (delivery) {
        delivery.driverId = null;
        delivery.vehicleId = null;
      }
    }

    return { detached: open.length, blocked: [] };
  }

  async updateRoute(
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,
  ): Promise<Route> {
    const route = this.routeOf(routeId, businessId);

    if (!route || !EDITABLE_STATUSES.includes(route.status)) {
      throw new RouteStatusConflictError();
    }

    Object.assign(route, {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.scheduled_date !== undefined && {
        scheduled_date: data.scheduled_date,
      }),
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
  ): Promise<RouteWithStops | null> {
    const route = this.routeOf(routeId, businessId);

    return route ? this.hydrate(route) : null;
  }

  async findDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<RouteWithStops | null> {
    const route =
      this.routes.find(
        (entry) =>
          entry.businessId === businessId &&
          entry.driverId === driverId &&
          entry.status === "IN_PROGRESS",
      ) ??
      this.routes.find(
        (entry) =>
          entry.businessId === businessId &&
          entry.driverId === driverId &&
          entry.status === "RELEASED",
      );

    return route ? this.hydrate(route) : null;
  }

  async listRoutes({
    businessId,
    page,
    pageSize,
    status,
    driverId,
  }: ListRoutesProps): Promise<ListRoutesResult> {
    const filtered = this.routes.filter(
      (route) =>
        route.businessId === businessId &&
        (!status || route.status === status) &&
        (!driverId || route.driverId === driverId),
    );

    const statusCounts = ROUTE_STATUSES.reduce(
      (tally, value) => ({
        ...tally,
        [value]: filtered.filter((route) => route.status === value).length,
      }),
      {} as Record<RouteStatus, number>,
    );

    return {
      data: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map((route) => this.hydrate(route)),
      total: filtered.length,
      meta: { statusCounts },
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

    route.updated_at = new Date();

    this.mirror(route);
    this.syncVehicleStatus(route);

    return route;
  }

  async addStops(
    routeId: string,
    businessId: string,
    deliveryIds: string[],
  ): Promise<RouteStop[]> {
    const route = this.routeOf(routeId, businessId);

    if (!route || !EDITABLE_STATUSES.includes(route.status)) {
      throw new RouteStatusConflictError();
    }

    this.assertDeliveriesFree(deliveryIds);

    const existing = this.stopsOf(routeId);

    let sequence = existing.length
      ? Math.max(...existing.map((stop) => stop.sequence))
      : null;

    const created: RouteStop[] = [];
    const now = new Date();

    for (const deliveryId of deliveryIds) {
      sequence = nextSequence(sequence);

      const stop: RouteStop = {
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

    return created;
  }

  async removeStop(
    routeId: string,
    businessId: string,
    stopId: string,
  ): Promise<void> {
    const route = this.routeOf(routeId, businessId);

    const stop = this.stops.find((entry) => entry.id === stopId);

    if (
      !route ||
      !EDITABLE_STATUSES.includes(route.status) ||
      !stop ||
      stop.routeId !== routeId
    ) {
      throw new RouteStopNotFoundError();
    }

    // Spliced, not reassigned: a test may be holding this exact array as
    // the delivery fake's view of the stops, and swapping it for a new one
    // would silently disconnect the two.
    this.stops.splice(this.stops.indexOf(stop), 1);

    const delivery = this.deliveries.find(
      (entry) => entry.id === stop.deliveryId && entry.businessId === businessId,
    );

    if (delivery) {
      delivery.driverId = null;
      delivery.vehicleId = null;
    }
  }

  async reorderStops(
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
  ): Promise<void> {
    const route = this.routeOf(routeId, businessId);

    if (!route || !EDITABLE_STATUSES.includes(route.status)) {
      throw new RouteStatusConflictError();
    }

    const currentIds = new Set(this.stopsOf(routeId).map((stop) => stop.id));
    const orderedIds = new Set(orderedStopIds);

    if (
      currentIds.size !== orderedIds.size ||
      orderedStopIds.some((id) => !currentIds.has(id))
    ) {
      throw new RouteReorderMismatchError();
    }

    for (const { id, sequence } of resequence(orderedStopIds)) {
      const stop = this.stops.find((entry) => entry.id === id);
      if (stop) stop.sequence = sequence;
    }
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

  async settleStopForDelivery(
    deliveryId: string,
    businessId: string,
    outcome: {
      from: RouteStopStatus[];
      status: RouteStopStatus;
      arrived_at?: Date;
      completed_at?: Date;
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
    if (!stop) return null;

    stop.status = outcome.status;
    if (outcome.arrived_at) stop.arrived_at = outcome.arrived_at;
    if (outcome.completed_at) stop.completed_at = outcome.completed_at;
    stop.updated_at = new Date();

    const route = this.routeOf(stop.routeId, businessId)!;

    const stillOpen = this.stopsOf(route.id).some((entry) =>
      isStopOpen(entry.status),
    );

    if (stillOpen) return { stop, closedRoute: null };

    route.status = "COMPLETED";
    route.completed_at = new Date();
    route.updated_at = new Date();

    // The route ended by itself, so the truck came back by itself too.
    this.syncVehicleStatus(route);

    return { stop, closedRoute: route };
  }
}

export { InMemoryRouteRepository };
