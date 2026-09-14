import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import {
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

const OPEN_STOP_STATUSES: RouteStopStatus[] = ["PENDING", "ARRIVED"];

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
        if (data.deliveryIds.length > 0) {
          await tx.delivery.updateMany({
            where: { id: { in: data.deliveryIds } },
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
    data: UpdateRouteProps,
  ): Promise<Route> {
    const updated = await this.prisma.route.update({
      where: { id: routeId },
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

    return updated as unknown as Route;
  }

  async findRouteById(routeId: string): Promise<RouteWithStops | null> {
    const found = await this.prisma.route.findUnique({
      where: { id: routeId },
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
          { driver: { name: { contains: normalizedSearch, mode: "insensitive" } } },
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
   * The status filter rides in the `where`, the same way it does in
   * assignDeliveries and updateDeliveryStatus: the read the caller validated
   * and the write it authorised become one atomic step, instead of two
   * separated by a window that four screens can drive through.
   */
  async transitionRoute(
    routeId: string,
    transition: RouteTransition,
  ): Promise<Route> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const moved = await tx.route.updateMany({
          where: { id: routeId, status: transition.expectedStatus },
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
   * Keeps `Delivery.driverId/vehicleId` equal to the route that owns them.
   *
   * These columns are the route's shadow, and this is their only writer. A
   * route that ends — completed or cancelled — releases the deliveries of its
   * stops that are still open, so they can be put on another route; the ones
   * already resolved keep the driver who resolved them, because that is the
   * historical fact the panels report.
   */
  private async mirrorOntoDeliveries(
    tx: Prisma.TransactionClient,
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

      await tx.delivery.updateMany({
        where: { id: { in: openDeliveryIds } },
        data: { driverId: null, vehicleId: null },
      });

      return;
    }

    await tx.delivery.updateMany({
      where: { id: { in: openDeliveryIds } },
      data: { driverId: route.driverId, vehicleId: route.vehicleId },
    });
  }

  async addStops(
    routeId: string,
    deliveryIds: string[],
  ): Promise<RouteStop[]> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const route = await tx.route.findUniqueOrThrow({
          where: { id: routeId },
          select: { driverId: true, vehicleId: true },
        });

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
          where: { id: { in: deliveryIds } },
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

  async removeStop(routeId: string, stopId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const stop = await tx.routeStop.findUnique({ where: { id: stopId } });

      if (!stop || stop.routeId !== routeId) {
        throw new RouteStopNotFoundError();
      }

      await tx.routeStop.delete({ where: { id: stopId } });

      // Back to the unassigned pool. Only the mirror is cleared — the delivery
      // keeps its own status, which removing it from a route never changed.
      await tx.delivery.update({
        where: { id: stop.deliveryId },
        data: { driverId: null, vehicleId: null },
      });
    });
  }

  async reorderStops(
    routeId: string,
    orderedStopIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
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

  async closeRouteIfFinished(routeId: string): Promise<Route | null> {
    const openStops = await this.prisma.routeStop.count({
      where: { routeId, status: { in: OPEN_STOP_STATUSES } },
    });

    if (openStops > 0) return null;

    const totalStops = await this.prisma.routeStop.count({ where: { routeId } });

    // A route with no stops never closes: it was never released, and closing
    // it would invent a completed route nobody ran — which the panel counts.
    if (totalStops === 0) return null;

    const closed = await this.prisma.route.updateMany({
      where: { id: routeId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    // Idempotent on purpose: an outbox resend of the event that triggered this
    // finds the route already COMPLETED and answers null, not an error.
    if (closed.count === 0) return null;

    const route = await this.prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    return route as unknown as Route;
  }
}

export { RouteRepository };
