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

import type { RouteStatus } from "@/shared/route/route-rules";

/**
 * A stand-in for Postgres, and the rules it enforces are not decoration.
 *
 * Two of this module's invariants live in the database as partial unique
 * indexes rather than in application code — precisely because a check in a use
 * case protects the path someone remembered, and the database protects every
 * other one. A fake that did not mirror them would accept writes the real
 * repository refuses, and a test proving the route module safe would be
 * proving nothing at all.
 *
 * So: R1 (one open stop per delivery, across every route) and R6 (one route in
 * progress per vehicle) are enforced here too, and raise the same errors.
 */
const ROUTE_STATUSES: RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

interface DeliveryMirror {
  id: string;
  driverId: string | null;
  vehicleId: string | null;
  kind?: string;
  status?: string;
  recipient_name?: string;
}

class InMemoryRouteRepository implements IRouteRepository {
  public routes: Route[] = [];
  public stops: RouteStop[] = [];

  /**
   * The delivery rows this repository mirrors onto. Tests seed it so the
   * mirroring is observable — it is an invariant of the module, not a detail.
   */
  public deliveries: DeliveryMirror[] = [];

  private stopsOf(routeId: string): RouteStop[] {
    return this.stops
      .filter((stop) => stop.routeId === routeId)
      .sort((a, b) => a.sequence - b.sequence);
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

    const open = this.stopsOf(route.id).filter((stop) => isStopOpen(stop.status));

    if (open.length === 0) return;

    if (ending) {
      for (const stop of open) stop.status = "CANCELLED";
    }

    for (const stop of open) {
      const delivery = this.deliveries.find(
        (entry) => entry.id === stop.deliveryId,
      );

      if (!delivery) continue;

      delivery.driverId = ending ? null : route.driverId;
      delivery.vehicleId = ending ? null : route.vehicleId;
    }
  }

  async createRoute(data: CreateRouteProps): Promise<RouteWithStops> {
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

      const delivery = this.deliveries.find((entry) => entry.id === deliveryId);

      if (delivery) {
        delivery.driverId = data.driverId;
        delivery.vehicleId = data.vehicleId ?? null;
      }
    });

    return this.hydrate(route);
  }

  async updateRoute(routeId: string, data: UpdateRouteProps): Promise<Route> {
    const route = this.routes.find((entry) => entry.id === routeId);
    if (!route) throw new RouteStopNotFoundError();

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

    return route;
  }

  async findRouteById(routeId: string): Promise<RouteWithStops | null> {
    const route = this.routes.find((entry) => entry.id === routeId);

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
    transition: RouteTransition,
  ): Promise<Route> {
    const route = this.routes.find((entry) => entry.id === routeId);

    // Mirrors the status filter in the Prisma `where`: the write only lands
    // while the row still holds the status the caller validated against.
    if (!route || route.status !== transition.expectedStatus) {
      throw new RouteStatusConflictError();
    }

    const nextVehicleId =
      transition.vehicleId !== undefined ? transition.vehicleId : route.vehicleId;

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

    return route;
  }

  async addStops(routeId: string, deliveryIds: string[]): Promise<RouteStop[]> {
    this.assertDeliveriesFree(deliveryIds);

    const route = this.routes.find((entry) => entry.id === routeId);
    if (!route) throw new RouteStopNotFoundError();

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

      const delivery = this.deliveries.find((entry) => entry.id === deliveryId);

      if (delivery) {
        delivery.driverId = route.driverId;
        delivery.vehicleId = route.vehicleId;
      }
    }

    return created;
  }

  async removeStop(routeId: string, stopId: string): Promise<void> {
    const stop = this.stops.find((entry) => entry.id === stopId);

    if (!stop || stop.routeId !== routeId) {
      throw new RouteStopNotFoundError();
    }

    this.stops = this.stops.filter((entry) => entry.id !== stopId);

    const delivery = this.deliveries.find(
      (entry) => entry.id === stop.deliveryId,
    );

    if (delivery) {
      delivery.driverId = null;
      delivery.vehicleId = null;
    }
  }

  async reorderStops(
    routeId: string,
    orderedStopIds: string[],
  ): Promise<void> {
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

  async closeRouteIfFinished(routeId: string): Promise<Route | null> {
    const stops = this.stopsOf(routeId);

    if (stops.length === 0) return null;
    if (stops.some((stop) => isStopOpen(stop.status))) return null;

    const route = this.routes.find((entry) => entry.id === routeId);

    // Idempotent: a resend finds it already closed and answers null.
    if (!route || route.status !== "IN_PROGRESS") return null;

    route.status = "COMPLETED";
    route.completed_at = new Date();

    return route;
  }
}

export { InMemoryRouteRepository };
