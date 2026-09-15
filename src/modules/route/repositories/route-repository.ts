import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import {
  OPEN_STOP_STATUSES,
  nextSequence,
  resequence,
  type RouteStopStatus,
} from "@/shared/route/route-rules";

import {
  DeliveryAlreadyOnRouteError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopNotFoundError,
  RouteVehicleBusyError,
} from "../usecases/errors/route-errors";

import type { IRouteRepository } from "./IRoute-repository";
import type {
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  Route,
  RouteStop,
  RouteTransition,
  RouteWithStops,
  UpdateRouteProps,
} from "../dtos/route-dto";

import type { RouteStatus } from "@/shared/route/route-rules";

/**
 * Everything a panel or the app needs about a route, in one read. Stops come
 * back in the dispatcher's order, which is the only order that means anything
 * to the driver.
 */
const routeInclude = {
  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, license_plate: true } },
  stops: {
    orderBy: { sequence: "asc" },
    include: {
      delivery: {
        select: {
          id: true,
          kind: true,
          status: true,
          recipient_name: true,
          city: true,
          uf: true,
          street: true,
          address_number: true,
          neighborhood: true,
        },
      },
    },
  },
} as const;

/** A route may only be edited while it has not been executed. */
const EDITABLE_STATUSES: RouteStatus[] = ["PLANNED", "RELEASED"];

const ROUTE_STATUSES: RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

/** Prisma's unique-violation code, and which index raised it. */
function violatedIndex(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = error.meta?.target;

  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.join(",");

  return "";
}

class RouteRepository implements IRouteRepository {
  constructor(private prisma = database) {}

  /**
   * Allocates the next per-company code.
   *
   * MAX + 1 read inside the caller's transaction, with the unique index as the
   * net: two dispatchers creating a route in the same instant both read the
   * same maximum, and the loser gets P2002 rather than a duplicate number.
   * `createRoute` retries once, which is enough — a third simultaneous
   * creation on the same company is not a case worth designing for.
   */
  private async nextCode(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<number> {
    const highest = await tx.route.aggregate({
      where: { businessId },
      _max: { code: true },
    });

    return (highest._max.code ?? 0) + 1;
  }

  async createRoute(data: CreateRouteProps): Promise<RouteWithStops> {
    const attempt = async (): Promise<RouteWithStops> =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.route.create({
          data: {
            code: await this.nextCode(tx, data.businessId),
            name: data.name ?? null,
            scheduled_date: data.scheduled_date,
            planned_departure_at: data.planned_departure_at ?? null,
            planned_arrival_at: data.planned_arrival_at ?? null,
            businessId: data.businessId,
            driverId: data.driverId,
            vehicleId: data.vehicleId ?? null,
            stops: {
              create: data.deliveryIds.map((deliveryId, index) => ({
                deliveryId,
                sequence: (index + 1) * 10,
              })),
            },
          },
          include: routeInclude,
        });

        // The route is PLANNED, so the deliveries are not on the road yet —
        // but the panel has to show who they are destined for, and driverId is
        // the column every existing screen reads. Mirroring starts here.
        //
        // The businessId in the `where` is not redundant with the use case's
        // check: this is the one statement in the module that writes to a
        // table the route does not own.
        if (data.deliveryIds.length > 0) {
          await tx.delivery.updateMany({
            where: { id: { in: data.deliveryIds }, businessId: data.businessId },
            data: { driverId: data.driverId, vehicleId: data.vehicleId ?? null },
          });
        }

        return created as unknown as RouteWithStops;
      });

    try {
      return await attempt();
    } catch (error) {
      const target = violatedIndex(error);

      if (target === null) throw error;

      if (target.includes("deliveryId")) {
        throw new DeliveryAlreadyOnRouteError(data.deliveryIds.length);
      }

      // Two dispatchers took the same code. One retry, then let it surface.
      return attempt();
    }
  }

  async updateRoute(
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,
  ): Promise<Route> {
    // Tenant AND state in the `where`. A route of another company matches no
    // row; so does one that has already been executed. Both come back as a
    // conflict, which is what the caller can act on.
    const updated = await this.prisma.route.updateMany({
      where: { id: routeId, businessId, status: { in: EDITABLE_STATUSES } },
      data: {
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
      },
    });

    if (updated.count === 0) throw new RouteStatusConflictError();

    const route = await this.prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    // Editing the driver or the vehicle changes what the shadow should say.
    await this.mirrorOntoDeliveries(this.prisma, route as unknown as Route);

    return route as unknown as Route;
  }

  async findRouteById(
    routeId: string,
    businessId: string,
  ): Promise<RouteWithStops | null> {
    const found = await this.prisma.route.findFirst({
      where: { id: routeId, businessId },
      include: routeInclude,
    });

    return found as unknown as RouteWithStops | null;
  }

  async findDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<RouteWithStops | null> {
    // In progress wins over released: a driver who already left is working
    // that route, whatever else is planned for them today.
    const found = await this.prisma.route.findFirst({
      where: {
        businessId,
        driverId,
        status: { in: ["IN_PROGRESS", "RELEASED"] },
      },
      orderBy: [{ status: "asc" }, { scheduled_date: "asc" }],
      include: routeInclude,
    });

    return found as unknown as RouteWithStops | null;
  }

  async listRoutes({
    businessId,
    page,
    pageSize,
    status,
    driverId,
    scheduled_date,
    search,
  }: ListRoutesProps): Promise<ListRoutesResult> {
    const normalizedSearch = search?.trim();

    const where: Prisma.RouteWhereInput = {
      businessId,
      ...(status && { status }),
      ...(driverId && { driverId }),
      ...(scheduled_date && { scheduled_date }),
      ...(normalizedSearch && {
        OR: [
          { name: { contains: normalizedSearch, mode: "insensitive" } },
          {
            driver: {
              name: { contains: normalizedSearch, mode: "insensitive" },
            },
          },
          // Spread of an ARRAY, never of an object: `...(cond ? {x} : {})`
          // leaves a bare {} in the OR, which is an empty conjunction and
          // therefore TRUE — it would discard the search term entirely. See
          // shared/pagination/search-or.
          ...(Number.isInteger(Number(normalizedSearch))
            ? [{ code: Number(normalizedSearch) }]
            : []),
        ],
      }),
    };

    // The status tally is a groupBy over the SAME where, without skip/take —
    // the cards describe the filtered set, never the page. Same shape the
    // vehicle module uses.
    const [data, statusGroups] = await Promise.all([
      this.prisma.route.findMany({
        where,
        include: routeInclude,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.route.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
    ]);

    // Prisma omits groups with no rows; the zeros have to be filled in or the
    // card reads "undefined" for a company with nothing cancelled.
    const statusCounts = ROUTE_STATUSES.reduce(
      (tally, value) => ({
        ...tally,
        [value]:
          statusGroups.find((group) => group.status === value)?._count._all ?? 0,
      }),
      {} as Record<RouteStatus, number>,
    );

    const total = ROUTE_STATUSES.reduce(
      (sum, value) => sum + statusCounts[value],
      0,
    );

    return {
      data: data as unknown as RouteWithStops[],
      total,
      meta: { statusCounts },
    };
  }

  /**
   * The status filter rides in the `where` alongside the tenant, the same way
   * it does in assignDeliveries and updateDeliveryStatus: the read the caller
   * validated and the write it authorised become one atomic step, instead of
   * two separated by a window that four screens can drive through.
   */
  async transitionRoute(
    routeId: string,
    businessId: string,
    transition: RouteTransition,
  ): Promise<Route> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const moved = await tx.route.updateMany({
          where: {
            id: routeId,
            businessId,
            status: transition.expectedStatus,
          },
          data: {
            status: transition.status,
            ...(transition.vehicleId !== undefined && {
              vehicleId: transition.vehicleId,
            }),
            ...(transition.started_at && { started_at: transition.started_at }),
            ...(transition.completed_at && {
              completed_at: transition.completed_at,
            }),
            ...(transition.cancellation_reason && {
              cancellation_reason: transition.cancellation_reason,
            }),
          },
        });

        if (moved.count === 0) {
          throw new RouteStatusConflictError();
        }

        const route = await tx.route.findUniqueOrThrow({
          where: { id: routeId },
        });

        await this.mirrorOntoDeliveries(tx, route as unknown as Route);

        return route as unknown as Route;
      });
    } catch (error) {
      // Raised by route_active_vehicle_idx: a second departure on a vehicle
      // that is already out. Nothing was written — the whole transaction rolls
      // back, including the mirroring.
      if (violatedIndex(error)?.includes("vehicleId")) {
        throw new RouteVehicleBusyError();
      }

      throw error;
    }
  }

  /**
   * Keeps the deliveries of a route's open stops equal to the route.
   *
   * `Delivery.driverId`, `Delivery.vehicleId` and — at the departure — the
   * delivery's own status are the route's shadow, and this is their only
   * writer. A route that ends releases the deliveries of its stops that are
   * still open, so they can go on another route; the ones already resolved
   * keep the driver who resolved them, because that is the historical fact the
   * panels report.
   *
   * The tenant is in every `where` even though the ids came from this route's
   * own stops. These are the statements in the module that write to a table
   * the route does not own, and that is exactly where a guard is worth
   * repeating.
   */
  private async mirrorOntoDeliveries(
    tx: Prisma.TransactionClient | typeof database,
    route: Route,
  ): Promise<void> {
    const ending = route.status === "COMPLETED" || route.status === "CANCELLED";

    const openDeliveryIds = (
      await tx.routeStop.findMany({
        where: { routeId: route.id, status: { in: OPEN_STOP_STATUSES } },
        select: { deliveryId: true },
      })
    ).map((stop) => stop.deliveryId);

    if (openDeliveryIds.length === 0) return;

    if (ending) {
      // Cancelling the route cancels its open stops, which is what frees the
      // deliveries under the partial unique index.
      await tx.routeStop.updateMany({
        where: { routeId: route.id, status: { in: OPEN_STOP_STATUSES } },
        data: { status: "CANCELLED" },
      });

      // The load that left with this route and never arrived goes back to the
      // pool it came from. Only IN_TRANSIT moves: a delivery the dispatcher
      // had already cancelled stays cancelled, and one still PENDING never
      // left.
      await tx.delivery.updateMany({
        where: {
          id: { in: openDeliveryIds },
          businessId: route.businessId,
          status: "IN_TRANSIT",
        },
        data: { status: "PENDING" },
      });

      await tx.delivery.updateMany({
        where: { id: { in: openDeliveryIds }, businessId: route.businessId },
        data: { driverId: null, vehicleId: null },
      });

      return;
    }

    await tx.delivery.updateMany({
      where: { id: { in: openDeliveryIds }, businessId: route.businessId },
      data: { driverId: route.driverId, vehicleId: route.vehicleId },
    });

    // The departure is what puts the load on the street, and it is the same
    // act as the route leaving — so it happens here, in the departure's own
    // transaction, rather than in a second request the app has to remember to
    // send. Without this the driver's next action is refused: arrival and
    // proof both require the delivery to be IN_TRANSIT.
    //
    // Only PENDING moves. A delivery already resolved keeps its outcome, and
    // the filter is what makes a re-run of the departure a no-op rather than
    // a load dragged back onto the street.
    if (route.status === "IN_PROGRESS") {
      await tx.delivery.updateMany({
        where: {
          id: { in: openDeliveryIds },
          businessId: route.businessId,
          status: "PENDING",
        },
        data: { status: "IN_TRANSIT" },
      });
    }
  }

  async addStops(
    routeId: string,
    businessId: string,
    deliveryIds: string[],
  ): Promise<RouteStop[]> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const route = await tx.route.findFirst({
          where: {
            id: routeId,
            businessId,
            status: { in: EDITABLE_STATUSES },
          },
          select: { driverId: true, vehicleId: true },
        });

        if (!route) throw new RouteStatusConflictError();

        const highest = await tx.routeStop.aggregate({
          where: { routeId },
          _max: { sequence: true },
        });

        let sequence = highest._max.sequence;

        const created: RouteStop[] = [];

        for (const deliveryId of deliveryIds) {
          sequence = nextSequence(sequence);

          const stop = await tx.routeStop.create({
            data: { routeId, deliveryId, sequence },
          });

          created.push(stop as unknown as RouteStop);
        }

        await tx.delivery.updateMany({
          where: { id: { in: deliveryIds }, businessId },
          data: { driverId: route.driverId, vehicleId: route.vehicleId },
        });

        return created;
      });
    } catch (error) {
      if (violatedIndex(error)?.includes("deliveryId")) {
        throw new DeliveryAlreadyOnRouteError(deliveryIds.length);
      }

      throw error;
    }
  }

  async removeStop(
    routeId: string,
    businessId: string,
    stopId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const stop = await tx.routeStop.findFirst({
        where: {
          id: stopId,
          routeId,
          route: { businessId, status: { in: EDITABLE_STATUSES } },
        },
      });

      if (!stop) throw new RouteStopNotFoundError();

      await tx.routeStop.delete({ where: { id: stopId } });

      // Back to the unassigned pool. Only the mirror is cleared — the delivery
      // keeps its own status, which removing it from a route never changed.
      await tx.delivery.updateMany({
        where: { id: stop.deliveryId, businessId },
        data: { driverId: null, vehicleId: null },
      });
    });
  }

  async reorderStops(
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const route = await tx.route.findFirst({
        where: { id: routeId, businessId, status: { in: EDITABLE_STATUSES } },
        select: { id: true },
      });

      if (!route) throw new RouteStatusConflictError();

      const current = await tx.routeStop.findMany({
        where: { routeId },
        select: { id: true },
      });

      const currentIds = new Set(current.map((stop) => stop.id));
      const orderedIds = new Set(orderedStopIds);

      // The complete list, not a move instruction. A mismatch means the
      // dispatcher was ordering a route someone else has since changed.
      if (
        currentIds.size !== orderedIds.size ||
        orderedStopIds.some((id) => !currentIds.has(id))
      ) {
        throw new RouteReorderMismatchError();
      }

      // Two passes, because @@unique([routeId, sequence]) would be violated
      // halfway through a single pass: moving stop B to position 1 collides
      // with stop A until A has moved. Negatives are free of collisions and
      // never observable — the whole thing is one transaction.
      for (const [index, id] of orderedStopIds.entries()) {
        await tx.routeStop.update({
          where: { id },
          data: { sequence: -(index + 1) },
        });
      }

      for (const { id, sequence } of resequence(orderedStopIds)) {
        await tx.routeStop.update({ where: { id }, data: { sequence } });
      }
    });
  }

  async findStopById(
    stopId: string,
    businessId: string,
  ): Promise<(RouteStop & { route: Route }) | null> {
    const found = await this.prisma.routeStop.findFirst({
      where: { id: stopId, route: { businessId } },
      include: { route: true },
    });

    return found as unknown as (RouteStop & { route: Route }) | null;
  }

  /**
   * Records the outcome of the stop a delivery occupies, and closes the route
   * if that was the last one open.
   *
   * Addressed by delivery rather than by stop id: the driver acts on a
   * delivery and the stop is the route's view of that act. One writer for one
   * fact.
   *
   * Never throws for "there is nothing to settle". Most deliveries in this
   * product are not on a route at all, and this runs on every delivery
   * outcome — a route with nothing to say must not sink a proof that was
   * already accepted.
   */
  async settleStopForDelivery(
    deliveryId: string,
    businessId: string,
    outcome: {
      from: RouteStopStatus[];
      status: RouteStopStatus;
      arrived_at?: Date;
      completed_at?: Date;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ stop: RouteStop; closedRoute: Route | null } | null> {
    const run = (client: Prisma.TransactionClient) =>
      this.settleWithin(client, deliveryId, businessId, outcome);

    // Prisma refuses a transaction opened on a transaction client, and a
    // caller that handed one over already owns the commit boundary — the
    // whole reason it passed it was to share this commit.
    if (tx) return run(tx);

    return this.prisma.$transaction(run);
  }

  private async settleWithin(
    client: Prisma.TransactionClient,
    deliveryId: string,
    businessId: string,
    outcome: {
      from: RouteStopStatus[];
      status: RouteStopStatus;
      arrived_at?: Date;
      completed_at?: Date;
    },
  ): Promise<{ stop: RouteStop; closedRoute: Route | null } | null> {
    // At most one row: route_stop_active_delivery_idx allows a delivery one
    // open stop, and `from` only ever names open statuses. The tenant and the
    // route's own status are part of the match, so a delivery id crafted from
    // another company finds nothing rather than something it should not.
    const target = await client.routeStop.findFirst({
      where: {
        deliveryId,
        status: { in: outcome.from },
        route: { businessId, status: "IN_PROGRESS" },
      },
      select: { id: true, routeId: true },
    });

    if (!target) return null;

    // The precondition rides in the `where` of the write, not only in the read
    // above: between the two the stop can move, and a blind update would
    // overwrite whatever it became.
    //
    // Note the tenant appears in BOTH clauses, and each makes the other
    // redundant for behaviour — deleting either one alone changes no outcome
    // and breaks no test, because the survivor still refuses. That is the
    // point of defence in depth, and also its blind spot: the suite proves the
    // PAIR, not each half. Do not remove one on the grounds that tests stay
    // green.
    const settled = await client.routeStop.updateMany({
      where: {
        id: target.id,
        status: { in: outcome.from },
        route: { businessId, status: "IN_PROGRESS" },
      },
      data: {
        status: outcome.status,
        ...(outcome.arrived_at && { arrived_at: outcome.arrived_at }),
        ...(outcome.completed_at && { completed_at: outcome.completed_at }),
      },
    });

    if (settled.count === 0) return null;

    const stop = await client.routeStop.findUniqueOrThrow({
      where: { id: target.id },
    });

    return {
      stop: stop as unknown as RouteStop,
      closedRoute: await this.closeIfFinished(client, target.routeId, businessId),
    };
  }

  /**
   * A route with nothing left open is finished, and closes itself.
   *
   * Not an endpoint: nobody presses "encerrar rota". The route ends because
   * its last stop resolved, which is a consequence of the domain rather than
   * a decision a user makes — and a button for it would let somebody close a
   * route with work still on it.
   */
  private async closeIfFinished(
    client: Prisma.TransactionClient,
    routeId: string,
    businessId: string,
  ): Promise<Route | null> {
    const stillOpen = await client.routeStop.count({
      where: { routeId, status: { in: OPEN_STOP_STATUSES } },
    });

    if (stillOpen > 0) return null;

    const closed = await client.route.updateMany({
      where: { id: routeId, businessId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    // Idempotent: a resend finds the route already closed and answers null
    // rather than failing.
    if (closed.count === 0) return null;

    const route = await client.route.findUniqueOrThrow({ where: { id: routeId } });

    return route as unknown as Route;
  }
}

export { RouteRepository };
