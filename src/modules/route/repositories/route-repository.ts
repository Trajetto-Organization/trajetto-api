import { Prisma, type PrismaClient } from "@prisma/client";

import database from "@/../infra/database";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import {
  groupedBy,
  relatedTo,
  rowsByKey,
} from "@/shared/database/related-rows";

import {
  OPEN_STOP_STATUSES,
  nextSequence,
  resequence,
  routeCompletedAt,
  type RouteStopStatus,
} from "@/shared/route/route-rules";
import { resolveTimeZone } from "@/shared/time/business-day";
import { isModuleEnabled } from "@/shared/entitlements/entitlement-rules";

import {
  ROUTE_SORT,
  catalogFacetOptions,
  routeListWhere,
  summarizeRouteList,
} from "../usecases/list-routes/route-list";

import {
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
  RouteCodeTakenError,
  RouteDriverBusyError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopsLimitError,
  RouteVehicleBusyError,
} from "../usecases/errors/route-errors";
import {
  PLANNING_TIMELINE_EVENTS_ENABLED,
  ROUTE_MAX_STOPS,
  assertPlanVersion,
} from "../usecases/shared/route-plan-rules";
import {
  UNROUTED_DELIVERY_SELECT,
  UNROUTED_FACET_LIMIT,
  orderShipperFacet,
  unroutedDeliveriesWhere,
  type UnroutedDeliveriesPage,
  type UnroutedDeliveriesQuery,
  type UnroutedDeliveryRow,
  type UnroutedFacet,
} from "../usecases/list-unrouted-deliveries/unrouted-deliveries";

import type { IRouteRepository } from "./IRoute-repository";
import type {
  AssignmentContext,
  AssignmentPreview,
  AssignmentPreviewProps,
  AssignmentRouteRef,
  CreateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  LockedRoute,
  OpenStopRoute,
  DetachResult,
  PinnedLocation,
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
} from "../dtos/route-dto";

import type { RouteStatus } from "@/shared/route/route-rules";
import { uniqueTargetOf } from "@/shared/errors/prisma-error-meta";

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

          // Carried so the departure can tell the people waiting. Two
          // nullable columns on a read the panel already does, rather than a
          // second query per stop when a forty-stop route leaves the yard.
          recipient_email: true,
          recipient_telephone: true,
          invoice_number: true,
          code: true,

          // The third identifier of a `delivery.assigned` payload, which is
          // built from these stops when a route changes hands.
          invoice_key: true,

          scheduled_date: true,
          businessId: true,

          // The address point for the route map (decision 14.7, D7).
          latitude: true,
          longitude: true,
          geo_source: true,
        },
      },
    },
  },
} as const;

/**
 * routeInclude, attached to a page of routes read without it: the driver and
 * the vehicle for the keys present, the stops of the page's routes and their
 * deliveries for the stops present. As an include, Prisma 7 queried the
 * deliveries of a page without stops and all four under an empty page
 * (shared/database/related-rows.ts). Same shape and stop order as the include.
 */
async function withRouteInclude<
  Row extends { id: string; driverId: string | null; vehicleId: string | null },
>(
  client: Pick<PrismaClient, "driver" | "vehicle" | "routeStop" | "delivery">,
  rows: Row[],
) {
  const [drivers, vehicles] = await Promise.all([
    rowsByKey(
      rows.map((row) => row.driverId),
      (ids) =>
        client.driver.findMany({
          where: { id: { in: ids } },
          select: routeInclude.driver.select,
        }),
    ),
    rowsByKey(
      rows.map((row) => row.vehicleId),
      (ids) =>
        client.vehicle.findMany({
          where: { id: { in: ids } },
          select: routeInclude.vehicle.select,
        }),
    ),
  ]);

  const stops = rows.length
    ? await client.routeStop.findMany({
        where: { routeId: { in: rows.map((row) => row.id) } },
        orderBy: routeInclude.stops.orderBy,
      })
    : [];

  const deliveries = await rowsByKey(
    stops.map((stop) => stop.deliveryId),
    (ids) =>
      client.delivery.findMany({
        where: { id: { in: ids } },
        select: routeInclude.stops.include.delivery.select,
      }),
  );

  const stopsByRoute = groupedBy(stops, (stop) => stop.routeId);

  return rows.map((row) => ({
    ...row,
    driver: relatedTo(drivers, row.driverId),
    vehicle: relatedTo(vehicles, row.vehicleId),
    stops: (stopsByRoute.get(row.id) ?? []).map((stop) => ({
      ...stop,
      delivery: relatedTo(deliveries, stop.deliveryId),
    })),
  }));
}

/** A route may only be edited while it has not been executed. */
const EDITABLE_STATUSES: RouteStatus[] = ["PLANNED", "RELEASED"];

/**
 * "The" running route of a driver, when there could be two: the oldest day,
 * then the oldest row. A total order, so every read that asks agrees.
 */
const RUNNING_ORDER: Prisma.RouteOrderByWithRelationInput[] = [
  { scheduled_date: "asc" },
  { created_at: "asc" },
  { id: "asc" },
];

/** How many routes or vehicles a warning names before it stops listing. */
const PREVIEW_LIMIT = 5;

/**
 * Prisma's unique-violation code, and which index raised it: the columns
 * ("deliveryId") under Prisma 6, which read them from Postgres' DETAIL; the
 * index name ("route_stop_active_delivery_idx") under Prisma 7. Callers match
 * a fragment of either, through the constants below.
 */
function violatedIndex(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = uniqueTargetOf(error);

  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.join(",");

  return "";
}

/** route_stop_active_delivery_idx: the delivery is on an open stop already. */
function isDeliveryOnRoute(target: string | null | undefined): boolean {
  return (
    !!target &&
    (target.includes("deliveryId") || target.includes("active_delivery"))
  );
}

/** route_active_vehicle_idx: the vehicle is out on another route. */
function isVehicleOnRoute(target: string | null | undefined): boolean {
  return (
    !!target &&
    (target.includes("vehicleId") || target.includes("active_vehicle"))
  );
}

class RouteRepository implements IRouteRepository {
  constructor(private prisma = database) {}

  /**
   * Allocates the next per-company code.
   *
   * MAX + 1 read inside the caller's transaction, under a per-company
   * advisory lock held until it commits. The unique index alone, with one
   * retry, was not enough: eight simultaneous creates in one company read the
   * same maximum and three answered 500. The lock queues allocators of the
   * same company (other companies never wait), and the next reader sees the
   * code the previous one committed. The index stays as the net.
   */
  private async nextCode(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`route-code:${businessId}`}, 0))`;

    const highest = await tx.route.aggregate({
      where: { businessId },
      _max: { code: true },
    });

    return (highest._max.code ?? 0) + 1;
  }

  async createRoute(
    data: CreateRouteProps,

    /**
     * The caller's transaction, when it has one.
     *
     * `create-route` wraps the insert and the `delivery.assigned` events it
     * announces in one unit of work: forty documents changing hands is forty
     * events, and a crash halfway through a loop that runs AFTER the commit
     * leaves a subscriber's ERP holding twenty of them with no way to know.
     *
     * With an outer transaction the code-collision retry below cannot run —
     * an aborted transaction cannot be continued — so the collision is
     * reported instead and the caller re-runs the whole unit.
     */
    outerTx?: Prisma.TransactionClient,
  ): Promise<RouteWithStops> {
    const write = async (
      tx: Prisma.TransactionClient,
    ): Promise<RouteWithStops> => {
      const created = await tx.route.create({
        data: {
          code: await this.nextCode(tx, data.businessId),
          name: data.name ?? null,
          scheduled_date: data.scheduled_date,
          destination: data.destination ?? null,
          planned_departure_at: data.planned_departure_at ?? null,
          planned_arrival_at: data.planned_arrival_at ?? null,
          businessId: data.businessId,
          driverId: data.driverId,
          vehicleId: data.vehicleId ?? null,
          importId: data.importId ?? null,
          client_submission_id: data.client_submission_id ?? null,
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
      //
      // PENDING in the `where` too: the use case checked it before the
      // transaction, and a cancellation committing in between would leave an
      // open stop for an address nobody will visit. The update waits for
      // that cancellation's row lock and re-reads the row, so a short count
      // is the cancellation having won — and the whole route rolls back.
      if (data.deliveryIds.length > 0) {
        const mirrored = await tx.delivery.updateMany({
          where: {
            id: { in: data.deliveryIds },
            businessId: data.businessId,
            status: "PENDING",
          },
          data: { driverId: data.driverId, vehicleId: data.vehicleId ?? null },
        });

        if (mirrored.count !== new Set(data.deliveryIds).size) {
          throw new DeliveryNoLongerRoutableError();
        }
      }

      return created as unknown as RouteWithStops;
    };

    const translate = (error: unknown): never => {
      const target = violatedIndex(error);

      // The Idempotency-Key's own index: the caller replays the twin.
      if (target === null || target.includes("client_submission_id")) {
        throw error;
      }

      if (isDeliveryOnRoute(target)) {
        throw new DeliveryAlreadyOnRouteError(data.deliveryIds.length);
      }

      throw new RouteCodeTakenError();
    };

    // The caller owns the transaction: no retry here, because an aborted
    // transaction cannot be continued. The collision travels up instead.
    if (outerTx) {
      try {
        return await write(outerTx);
      } catch (error) {
        return translate(error);
      }
    }

    const attempt = (): Promise<RouteWithStops> =>
      this.prisma.$transaction((tx) => write(tx));

    try {
      return await attempt();
    } catch (error) {
      const target = violatedIndex(error);

      if (target === null || target.includes("client_submission_id")) {
        throw error;
      }

      if (isDeliveryOnRoute(target)) {
        throw new DeliveryAlreadyOnRouteError(data.deliveryIds.length);
      }

      // Two dispatchers took the same code. One retry, then let it surface.
      return attempt();
    }
  }

  async detachFromOpenRoutes(
    deliveryIds: string[],
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DetachResult> {
    if (deliveryIds.length === 0) {
      return { detached: 0, blocked: [], emptiedRoutes: [], bumped: [] };
    }

    const run = async (
      client: Prisma.TransactionClient,
    ): Promise<DetachResult> => {
      const openStops = () =>
        client.routeStop.findMany({
          where: {
            deliveryId: { in: deliveryIds },
            status: { in: OPEN_STOP_STATUSES },

            // The tenant sits on the ROUTE, which is what owns the stop. A
            // caller who guessed another company's delivery id finds nothing.
            route: { businessId },
          },
          select: {
            id: true,
            deliveryId: true,
            routeId: true,
            route: { select: { status: true } },
            delivery: { select: { code: true, recipient_name: true } },
          },
        });

      let stops = await openStops();

      if (stops.length === 0) {
        return { detached: 0, blocked: [], emptiedRoutes: [], bumped: [] };
      }

      /**
       * The routes are locked before anything is decided, and the stops read
       * again once they are.
       *
       * The status in the read above can be stale by the time the stops are
       * deleted: a departure committing in between put these loads on the
       * street, and deleting their stops then left them IN_TRANSIT with no
       * stop and no driver. FOR UPDATE waits for that departure (its UPDATE
       * holds a lock this one conflicts with), and the re-read sees what won.
       * Ids in order, so two detaches over overlapping routes queue instead
       * of deadlocking. A stop that appeared on a route not yet locked is
       * picked up by the loop.
       */
      const locked = new Set<string>();

      for (;;) {
        const pending = [...new Set(stops.map((stop) => stop.routeId))]
          .filter((routeId) => !locked.has(routeId))
          .sort();

        if (pending.length === 0) break;

        await client.$queryRaw`
          SELECT "id" FROM "route"
          WHERE "id" IN (${Prisma.join(pending)}) AND "businessId" = ${businessId}
          ORDER BY "id"
          FOR UPDATE
        `;

        pending.forEach((routeId) => locked.add(routeId));

        stops = await openStops();
      }

      if (stops.length === 0) {
        return { detached: 0, blocked: [], emptiedRoutes: [], bumped: [] };
      }

      const blocked = stops
        .filter((stop) => !EDITABLE_STATUSES.includes(stop.route.status))
        .map((stop) => stop.delivery.code ?? stop.delivery.recipient_name);

      // All-or-nothing: a partial detach would leave the dispatcher with half
      // a selection moved and no way to tell which half.
      if (blocked.length > 0) {
        return { detached: 0, blocked, emptiedRoutes: [], bumped: [] };
      }

      const detachedIds = stops.map((stop) => stop.deliveryId);

      await client.routeStop.deleteMany({
        where: { id: { in: stops.map((stop) => stop.id) } },
      });

      /**
       * Back to the unassigned pool, exactly as `removeStop` does it: only
       * the mirror is cleared, because leaving a route never changed the
       * delivery's own status.
       *
       * The `businessId` here is redundant and stays anyway. The stops above
       * were found through `route: { businessId }`, so these ids are already
       * this tenant's by construction — a mutation that removes it therefore
       * survives, and it is the one write in this method that reaches a table
       * the route does not own. Cheap insurance against the day the query
       * above is loosened.
       */
      await client.delivery.updateMany({
        where: { id: { in: detachedIds }, businessId },
        data: { driverId: null, vehicleId: null },
      });

      // The routes this left with no stop at all, for the caller to settle: a
      // released route with nothing on it is a promise to a driver that no
      // longer means anything.
      const affected = [...new Set(stops.map((stop) => stop.routeId))];

      // Every route that lost a stop has a new plan (D5), under the locks
      // taken above: a screen or a release holding the old version is told.
      const bumped = await this.bumpPlanVersions(affected, businessId, client);

      const stillHolding = new Set(
        (
          await client.routeStop.findMany({
            where: { routeId: { in: affected } },
            select: { routeId: true },
            distinct: ["routeId"],
          })
        ).map((stop) => stop.routeId),
      );

      const emptiedIds = affected.filter(
        (routeId) => !stillHolding.has(routeId),
      );

      // Read here, inside the caller's transaction, rather than by the caller
      // through another connection while this one holds the locks.
      const emptiedRoutes =
        emptiedIds.length === 0
          ? []
          : ((await client.route.findMany({
              where: { id: { in: emptiedIds }, businessId },
            })) as unknown as Route[]);

      return {
        detached: detachedIds.length,
        blocked: [],
        emptiedRoutes,
        bumped,
      };
    };

    // A caller that handed over its transaction owns the commit boundary: the
    // reassignment detaches, builds the new route and releases it as one unit.
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  async inspectOpenStops(
    deliveryIds: string[],
    businessId: string,
  ): Promise<{ holder: Route | null; blocked: string[] }> {
    const wanted = new Set(deliveryIds);

    if (wanted.size === 0) return { holder: null, blocked: [] };

    const held = await this.prisma.routeStop.findMany({
      where: {
        deliveryId: { in: [...wanted] },
        status: { in: OPEN_STOP_STATUSES },
        route: { businessId },
      },
      select: {
        routeId: true,
        route: { select: { status: true } },
        delivery: { select: { code: true, recipient_name: true } },
      },
    });

    const blocked = held
      .filter((stop) => !EDITABLE_STATUSES.includes(stop.route.status))
      .map((stop) => stop.delivery.code ?? stop.delivery.recipient_name);

    // Every delivery holds an open stop (at most one each, by the partial
    // unique index), and all of them on the same route...
    const routeIds = new Set(held.map((stop) => stop.routeId));

    if (held.length !== wanted.size || routeIds.size !== 1) {
      return { holder: null, blocked };
    }

    const [routeId] = routeIds;

    // ... which has nothing else open.
    const open = await this.prisma.routeStop.count({
      where: { routeId, status: { in: OPEN_STOP_STATUSES } },
    });

    if (open !== wanted.size) return { holder: null, blocked };

    const route = await this.prisma.route.findFirst({
      where: { id: routeId, businessId },
    });

    return { holder: route as unknown as Route | null, blocked };
  }

  async updateRoute(
    routeId: string,
    businessId: string,
    data: UpdateRouteProps,

    /**
     * The caller's transaction, when it has one, so the `delivery.assigned`
     * events a new driver or vehicle means commit with the change. Without
     * one the three statements below run in a transaction of their own: they
     * used to run bare, and a failure after the update left the route with a
     * new driver and its deliveries still naming the old one.
     */
    tx?: Prisma.TransactionClient,
    options: PlanWriteOptions = {},
  ): Promise<Route> {
    if (!tx) {
      return this.prisma.$transaction((inner) =>
        this.updateRoute(routeId, businessId, data, inner, options),
      );
    }

    // The plan version is checked under the row lock: two dispatchers saving
    // the same route queue here, and the second one is told (D5).
    const locked = await this.lockEditableRoute(tx, routeId, businessId);

    if (!locked) throw new RouteStatusConflictError();

    assertPlanVersion(locked.planVersion, options.expectedPlanVersion);

    // Tenant AND state in the `where`. A route of another company matches no
    // row; so does one that has already been executed. Both come back as a
    // conflict, which is what the caller can act on.
    const updated = await tx.route.updateMany({
      where: { id: routeId, businessId, status: { in: EDITABLE_STATUSES } },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.scheduled_date !== undefined && {
          scheduled_date: data.scheduled_date,
        }),
        ...(data.destination !== undefined && {
          destination: data.destination,
        }),
        ...(data.planned_departure_at !== undefined && {
          planned_departure_at: data.planned_departure_at,
        }),
        ...(data.planned_arrival_at !== undefined && {
          planned_arrival_at: data.planned_arrival_at,
        }),
        ...(data.driverId !== undefined && { driverId: data.driverId }),
        ...(data.vehicleId !== undefined && { vehicleId: data.vehicleId }),

        // Crew and window are part of the plan the driver follows.
        plan_version: { increment: 1 },
      },
    });

    if (updated.count === 0) throw new RouteStatusConflictError();

    const route = await tx.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    // Editing the driver or the vehicle changes what the shadow should say.
    await this.mirrorOntoDeliveries(tx, route as unknown as Route);

    return route as unknown as Route;
  }

  async findRouteById(
    routeId: string,
    businessId: string,

    /** Read inside the caller's transaction — after its own write. */
    tx?: Prisma.TransactionClient,
  ): Promise<RouteWithStops | null> {
    const found = await (tx ?? this.prisma).route.findFirst({
      where: { id: routeId, businessId },
      include: routeInclude,
    });

    return found as unknown as RouteWithStops | null;
  }

  async findDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<RouteWithStops | null> {
    /**
     * In progress wins over released: a driver who already left is working
     * that route, whatever else is planned for them today.
     *
     * `desc` and not `asc`, which is what this said for as long as it
     * existed. Postgres orders an enum by its DECLARED position, and the
     * declaration is PLANNED, RELEASED, IN_PROGRESS — so ascending put
     * RELEASED first and the comment above described the opposite of what
     * the query did.
     *
     * It cost more than a wrong screen. A driver who had departed and also
     * had tomorrow's route released got the released one back, and
     * `record-driver-positions` reads `status === "IN_PROGRESS"` to decide
     * whether to store anything: every ping of that shift was answered with
     * `tracking: false` and thrown away. The in-memory repository had always
     * done it correctly, which is why no unit test ever noticed.
     *
     * The ordinal dependence is real, so `scheduled_date` cannot save it: if
     * a status is ever inserted between RELEASED and IN_PROGRESS, this
     * changes meaning silently. The E2E that departs and then flushes a
     * position is what holds it.
     *
     * `created_at` and `id` after the day: `scheduled_date` is a date now,
     * so two routes of the same day ALWAYS tie there, and without a total
     * order Postgres may hand back either one — the app and the position
     * flush could disagree about which route the driver is on.
     */
    const found = await this.prisma.route.findFirst({
      where: {
        businessId,
        driverId,
        status: { in: ["IN_PROGRESS", "RELEASED"] },
      },
      orderBy: [
        { status: "desc" },
        { scheduled_date: "asc" },
        { created_at: "asc" },
        { id: "asc" },
      ],
      include: routeInclude,
    });

    return found as unknown as RouteWithStops | null;
  }

  async findActiveRouteForDriver(
    businessId: string,
    driverId: string,
  ): Promise<{ id: string; started_at: Date | null } | null> {
    // One statement on (businessId, driverId, status). Ordered like
    // findDriverRoute's IN_PROGRESS branch, so a driver who somehow has two
    // running routes gets the same one from both.
    return this.prisma.route.findFirst({
      where: { businessId, driverId, status: "IN_PROGRESS" },
      orderBy: RUNNING_ORDER,
      select: { id: true, started_at: true },
    });
  }

  async businessTimeZone(businessId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });

    return resolveTimeZone(business?.timezone);
  }

  async assignmentContext(businessId: string): Promise<AssignmentContext> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        timezone: true,
        entitlements: {
          where: { module: "FLEET" },
          select: { module: true, enabled: true },
        },
      },
    });

    return {
      timeZone: resolveTimeZone(business?.timezone),
      fleetEnabled: isModuleEnabled(business?.entitlements ?? [], "FLEET"),
    };
  }

  async lockDriverStatus(
    driverId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "driver"
       WHERE "id" = ${driverId} AND "businessId" = ${businessId}
         FOR SHARE`;

    return rows[0]?.status ?? null;
  }

  async assertDriverFreeToDepart(
    driverId: string,
    businessId: string,
    routeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient): Promise<void> => {
      // Per driver, held to the commit: a second departure of the same
      // driver waits here and then reads the first one's committed row.
      await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`route-driver-departure:${driverId}`}, 0))`;

      const running = await client.route.findFirst({
        where: {
          businessId,
          driverId,
          status: "IN_PROGRESS",
          id: { not: routeId },
        },
        orderBy: RUNNING_ORDER,
        select: { code: true },
      });

      if (running) throw new RouteDriverBusyError(running.code);
    };

    // The lock is only worth anything inside the departure's own
    // transaction; without one it is taken and released around the read.
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  async assignmentPreview({
    businessId,
    driverId,
    vehicleId,
    day,
    deliveryIds = [],
    fleetFacts,
  }: AssignmentPreviewProps): Promise<AssignmentPreview> {
    const refSelect = {
      id: true,
      code: true,
      status: true,
      driver: { select: { name: true } },
    } as const;

    const toRef = (row: {
      id: string;
      code: number;
      status: RouteStatus;
      driver: { name: string } | null;
    }): AssignmentRouteRef => ({
      id: row.id,
      code: row.code,
      status: row.status,
      driverName: row.driver?.name ?? null,
    });

    const routesOnDay = (owner: { driverId: string } | { vehicleId: string }) =>
      this.prisma.route.findMany({
        where: {
          businessId,
          ...owner,
          scheduled_date: day,
          status: { in: EDITABLE_STATUSES },
        },
        orderBy: { code: "asc" },
        take: PREVIEW_LIMIT,
        select: refSelect,
      });

    const runningRoute = (
      owner: { driverId: string } | { vehicleId: string },
    ) =>
      this.prisma.route.findFirst({
        where: { businessId, ...owner, status: "IN_PROGRESS" },
        orderBy: RUNNING_ORDER,
        select: refSelect,
      });

    /*
     * Two queries in flight at most, never seven: every parallel query takes
     * its own pool connection, and the dialogs ask this on each change while
     * the drivers' proof writes queue on the same pool. Every read carries
     * the tenant: a driver or vehicle id of another company finds nothing,
     * the same as one that does not exist.
     */
    const [driver, vehicle] = await Promise.all([
      this.prisma.driver.findFirst({
        where: { id: driverId, businessId },
        select: {
          id: true,
          name: true,
          status: true,
          cnh_category: true,
          cnh_expires_at: true,
        },
      }),
      vehicleId
        ? this.prisma.vehicle.findFirst({
            where: { id: vehicleId, businessId },
            select: {
              id: true,
              license_plate: true,
              description: true,
              status: true,
              driver: { select: { id: true, name: true } },
              vehicleType: { select: { required_cnh_category: true } },
            },
          })
        : null,
    ]);

    // The use case answers 404 for either; nothing else is worth reading.
    if (!driver || (vehicleId && !vehicle)) {
      return {
        driver,
        driverRunningRoute: null,
        driverRoutesOnDay: [],
        responsibleVehicles: [],
        vehicle: null,
        vehicleRunningRoute: null,
        vehicleRoutesOnDay: [],
        routesEmptiedBySelection: [],
      };
    }

    const [driverRunningRoute, driverRoutesOnDay] = await Promise.all([
      runningRoute({ driverId }),
      routesOnDay({ driverId }),
    ]);

    const [vehicleRunningRoute, vehicleRoutesOnDay] = vehicleId
      ? await Promise.all([
          runningRoute({ vehicleId }),
          routesOnDay({ vehicleId }),
        ])
      : [null, []];

    const withFleet = fleetFacts && vehicleId != null;

    const [responsibleVehicles, openOrders] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { businessId, driverId, status: { in: ["ACTIVE", "IN_ROUTE"] } },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: PREVIEW_LIMIT,
        select: {
          id: true,
          license_plate: true,
          description: true,
          status: true,
        },
      }),
      // A count and the oldest date, never the rows: a truck parked in the
      // shop for months must not grow this read.
      withFleet
        ? this.prisma.serviceOrder.aggregate({
            where: { businessId, vehicleId: vehicleId!, completion_date: null },
            _count: { _all: true },
            _min: { date: true },
          })
        : null,
    ]);

    // routesEmptiedBy runs its two reads one after the other: with the
    // checklist beside it, still two at a time.
    const [lastChecklist, routesEmptiedBySelection] = await Promise.all([
      withFleet
        ? this.prisma.vehicleChecklist.findFirst({
            where: { businessId, vehicleId: vehicleId! },
            orderBy: [
              { checklist_date: "desc" },
              { created_at: "desc" },
              { id: "desc" },
            ],
            select: { overall_condition: true, checklist_date: true },
          })
        : null,
      this.routesEmptiedBy(deliveryIds, businessId),
    ]);

    return {
      driver,
      driverRunningRoute: driverRunningRoute ? toRef(driverRunningRoute) : null,
      driverRoutesOnDay: driverRoutesOnDay.map(toRef),
      responsibleVehicles,
      vehicle: vehicle
        ? {
            id: vehicle.id,
            license_plate: vehicle.license_plate,
            description: vehicle.description,
            status: vehicle.status,
            responsible: vehicle.driver,
            required_cnh_category:
              vehicle.vehicleType?.required_cnh_category ?? null,
            openServiceOrders: openOrders
              ? {
                  count: openOrders._count._all,
                  oldest: openOrders._min.date ?? null,
                }
              : null,
            lastChecklist: lastChecklist ?? null,
          }
        : null,
      vehicleRunningRoute: vehicleRunningRoute
        ? toRef(vehicleRunningRoute)
        : null,
      vehicleRoutesOnDay: vehicleRoutesOnDay.map(toRef),
      routesEmptiedBySelection,
    };
  }

  /**
   * The RELEASED routes the batch assignment would empty (and so cancel):
   * those whose open stops are ALL in the selection. The same rule
   * detachFromOpenRoutes applies when it reports `emptiedRoutes`.
   */
  private async routesEmptiedBy(
    deliveryIds: string[],
    businessId: string,
  ): Promise<string[]> {
    if (deliveryIds.length === 0) return [];

    const held = await this.prisma.routeStop.groupBy({
      by: ["routeId"],
      where: {
        deliveryId: { in: [...new Set(deliveryIds)] },
        status: { in: OPEN_STOP_STATUSES },
        route: { businessId, status: "RELEASED" },
      },
      _count: { _all: true },
    });

    if (held.length === 0) return [];

    const open = await this.prisma.routeStop.groupBy({
      by: ["routeId"],
      where: {
        routeId: { in: held.map((group) => group.routeId) },
        status: { in: OPEN_STOP_STATUSES },
      },
      _count: { _all: true },
    });

    const openBy = new Map(
      open.map((group) => [group.routeId, group._count._all]),
    );

    return held
      .filter((group) => openBy.get(group.routeId) === group._count._all)
      .map((group) => group.routeId)
      .sort();
  }

  async listRoutes({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListRoutesProps): Promise<ListRoutesResult> {
    // The page and the status counts side by side (the two connections a
    // screen may hold). The counts replace a count(*): the pager total and
    // the cards both come out of them, without skip/take — they describe the
    // filtered set, never the page.
    const [rows, byStatus] = await Promise.all([
      this.prisma.route.findMany({
        where: routeListWhere(filters),
        orderBy: resolveOrderBy(ROUTE_SORT, { sort, order }),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.route.groupBy({
        by: ["status"],
        where: routeListWhere(filters, { except: "status" }),
        _count: { _all: true },
      }),
    ]);

    const data = await withRouteInclude(this.prisma, rows);

    // The catalog facets after, one query at a time: each counted without
    // its own facet, and named from the company's own rows only.
    const byDriver = await this.prisma.route.groupBy({
      by: ["driverId"],
      where: routeListWhere(filters, { except: "driverId" }),
      _count: { _all: true },
    });

    const driverIds = [
      ...new Set([
        ...byDriver.map((group) => group.driverId),
        ...(filters.driverIds ?? []),
      ]),
    ];

    const drivers = driverIds.length
      ? await this.prisma.driver.findMany({
          where: { businessId: filters.businessId, id: { in: driverIds } },
          select: { id: true, name: true },
        })
      : [];

    const byVehicle = await this.prisma.route.groupBy({
      by: ["vehicleId"],
      where: routeListWhere(filters, { except: "vehicleId" }),
      _count: { _all: true },
    });

    const vehicleIds = [
      ...new Set([
        ...byVehicle.flatMap((group) =>
          group.vehicleId ? [group.vehicleId] : [],
        ),
        ...(filters.vehicleIds ?? []),
      ]),
    ];

    const vehicles = vehicleIds.length
      ? await this.prisma.vehicle.findMany({
          where: { businessId: filters.businessId, id: { in: vehicleIds } },
          select: { id: true, license_plate: true },
        })
      : [];

    const { total, searchMeta } = summarizeRouteList(
      byStatus.map((group) => ({
        value: group.status,
        count: group._count._all,
      })),
      filters,
      {
        drivers: catalogFacetOptions(
          byDriver.map((group) => ({
            value: group.driverId,
            count: group._count._all,
          })),
          filters.driverIds,
          new Map(drivers.map((driver) => [driver.id, driver.name])),
        ),
        vehicles: catalogFacetOptions(
          byVehicle.map((group) => ({
            value: group.vehicleId,
            count: group._count._all,
          })),
          filters.vehicleIds,
          new Map(
            vehicles.map((vehicle) => [vehicle.id, vehicle.license_plate]),
          ),
        ),
      },
    );

    return {
      data: data as unknown as RouteWithStops[],
      total,
      meta: searchMeta,
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
    tx?: Prisma.TransactionClient,
  ): Promise<Route> {
    const run = async (client: Prisma.TransactionClient): Promise<Route> => {
      const moved = await client.route.updateMany({
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

          // When the route was handed over (decision 14.4 reads it for the
          // journey); pulling it back to planning makes it a draft again.
          ...(transition.status === "RELEASED" && { released_at: new Date() }),
          ...(transition.status === "PLANNED" && { released_at: null }),
        },
      });

      if (moved.count === 0) {
        throw new RouteStatusConflictError();
      }

      const route = await client.route.findUniqueOrThrow({
        where: { id: routeId },
      });

      await this.mirrorOntoDeliveries(client, route as unknown as Route);
      await this.syncVehicleStatus(client, route as unknown as Route);

      return route as unknown as Route;
    };

    try {
      // A caller that handed over its transaction owns the commit boundary —
      // it is publishing a notification that must exist if and only if this
      // write lands. Prisma also refuses a transaction opened on one.
      return tx ? await run(tx) : await this.prisma.$transaction(run);
    } catch (error) {
      // Raised by route_active_vehicle_idx: a second departure on a vehicle
      // that is already out. Nothing was written — the whole transaction rolls
      // back, including the mirroring.
      if (isVehicleOnRoute(violatedIndex(error))) {
        throw new RouteVehicleBusyError();
      }

      // The database twin of assertDriverFreeToDepart, once the partial
      // unique index on (driverId) WHERE IN_PROGRESS exists (schema round).
      const target = violatedIndex(error);

      if (target?.includes("driverId") || target?.includes("active_driver")) {
        throw new RouteDriverBusyError();
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

  /**
   * Keeps `Vehicle.status` equal to whether the vehicle is actually out.
   *
   * IN_ROUTE used to be a value a person typed into a form, which meant it was
   * true only until the truck came back and nobody remembered to change it.
   * It is a FACT about a route, so the route writes it and nothing else does —
   * the vehicle form no longer offers it.
   *
   * Both writes are conditional, and that is what makes them safe to run
   * blindly. The departure only moves ACTIVE → IN_ROUTE, so it cannot drag a
   * vehicle out of BLOCKED; the return only moves IN_ROUTE → ACTIVE, so a
   * vehicle blocked by an administrator WHILE it was on the road (theft, a
   * crash) stays blocked when the route ends instead of being quietly
   * reopened for service.
   */
  private async syncVehicleStatus(
    tx: Prisma.TransactionClient | typeof database,
    route: Route,
  ): Promise<void> {
    if (!route.vehicleId) return;

    if (route.status === "IN_PROGRESS") {
      await tx.vehicle.updateMany({
        where: {
          id: route.vehicleId,
          businessId: route.businessId,
          status: "ACTIVE",
        },
        data: { status: "IN_ROUTE" },
      });

      return;
    }

    // Only a route that LEFT gives the truck back. A released route cancelled
    // before departure never took it out — and the same truck may be on the
    // street right now with another route, which this would have marked free
    // (and so bookable for a second departure).
    if (
      (route.status === "COMPLETED" || route.status === "CANCELLED") &&
      route.started_at
    ) {
      await tx.vehicle.updateMany({
        where: {
          id: route.vehicleId,
          businessId: route.businessId,
          status: "IN_ROUTE",
        },
        data: { status: "ACTIVE" },
      });
    }
  }

  /**
   * Takes the route row for a composition write (add, remove, reorder) and
   * answers whether the route may still be edited — null when it is gone,
   * belongs to another company, or has left.
   *
   * FOR UPDATE and not a plain read. The departure is an UPDATE, which holds
   * FOR NO KEY UPDATE on this row, and an INSERT into route_stop only takes
   * FOR KEY SHARE through the foreign key: the two do not conflict, so a
   * composition that merely READ the status ran beside the departure and
   * committed on a snapshot the departure had already changed — a PENDING stop
   * on a running route, or a load on the street with no stop and no driver.
   * FOR UPDATE conflicts with the departure's lock, so one waits for the
   * other; under READ COMMITTED the waiter gets the committed row back, and
   * the status below is the one that won.
   */
  private async lockEditableRoute(
    tx: Prisma.TransactionClient,
    routeId: string,
    businessId: string,
  ): Promise<LockedRoute | null> {
    const rows = await tx.$queryRaw<
      Array<{
        status: RouteStatus;
        driverId: string;
        vehicleId: string | null;
        code: number;
        plan_version: number;
      }>
    >`
      SELECT "status", "driverId", "vehicleId", "code", "plan_version"
      FROM "route"
      WHERE "id" = ${routeId} AND "businessId" = ${businessId}
      FOR UPDATE
    `;

    const route = rows[0];

    if (!route || !EDITABLE_STATUSES.includes(route.status)) return null;

    return {
      status: route.status,
      driverId: route.driverId,
      vehicleId: route.vehicleId,
      code: route.code,
      planVersion: route.plan_version,
    };
  }

  /**
   * plan_version + 1, inside the caller's lock (D5). The new value is what
   * the response and the socket hint carry.
   */
  private async bumpPlanVersion(
    tx: Prisma.TransactionClient,
    routeId: string,
  ): Promise<number> {
    const bumped = await tx.route.update({
      where: { id: routeId },
      data: { plan_version: { increment: 1 } },
      select: { plan_version: true },
    });

    return bumped.plan_version;
  }

  /**
   * One timeline line per delivery that joined or left a route's plan.
   * Planning, not operation: the tower feed skips these types.
   */
  async recordPlanEvents(
    tx: Prisma.TransactionClient,
    rows: Array<{ deliveryId: string; note: string }>,
    {
      type,
      routeId,
      businessId,
      actorId,
    }: {
      type: "ROUTE_ADDED" | "ROUTE_REMOVED";
      routeId: string;
      businessId: string;
      actorId?: string | null;
    },
  ): Promise<void> {
    // Held back until the timeline readers know these types (see the gate).
    if (rows.length === 0 || !PLANNING_TIMELINE_EVENTS_ENABLED) return;

    await tx.deliveryEvent.createMany({
      data: rows.map((row) => ({
        type,
        deliveryId: row.deliveryId,
        businessId,
        routeId,
        actor: "USER" as const,
        reportedById: actorId ?? null,
        note: row.note,
      })),
    });
  }

  async lockRoutes(
    routeIds: string[],
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const ids = [...new Set(routeIds)].sort();

    if (ids.length === 0) return;

    // Id order, the same order detachFromOpenRoutes takes: two moves across
    // the same pair of routes (A→B and B→A) queue instead of deadlocking.
    await tx.$queryRaw`
      SELECT "id" FROM "route"
      WHERE "id" IN (${Prisma.join(ids)}) AND "businessId" = ${businessId}
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  async bumpPlanVersions(
    routeIds: string[],
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanBump[]> {
    const bumped: PlanBump[] = [];

    for (const routeId of [...new Set(routeIds)].sort()) {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          code: number;
          status: RouteStatus;
          driverId: string;
          plan_version: number;
        }>
      >`
        UPDATE "route" SET "plan_version" = "plan_version" + 1
        WHERE "id" = ${routeId} AND "businessId" = ${businessId}
        RETURNING "id", "code", "status", "driverId", "plan_version"
      `;

      const row = rows[0];

      if (row) {
        bumped.push({
          routeId: row.id,
          code: row.code,
          status: row.status,
          driverId: row.driverId,
          planVersion: row.plan_version,
        });
      }
    }

    return bumped;
  }

  async findRouteBySubmission(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<RouteWithStops | null> {
    const found = await this.prisma.route.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: clientSubmissionId,
        },
      },
      include: routeInclude,
    });

    return found as unknown as RouteWithStops | null;
  }

  async addStops(
    routeId: string,
    businessId: string,
    deliveryIds: string[],

    /**
     * The caller's transaction, when it has one, so the `delivery.assigned`
     * events for the new stops commit with them — and are read, with the
     * route's driver, under the lock taken here.
     */
    outerTx?: Prisma.TransactionClient,
    options: PlanWriteOptions = {},
  ): Promise<PlanStopsAdded> {
    const run = async (
      tx: Prisma.TransactionClient,
    ): Promise<PlanStopsAdded> => {
      // Locked, not merely read: see lockEditableRoute. A departure
      // committing in between is what the lock waits for, and what the
      // status re-read after it then refuses.
      const route = await this.lockEditableRoute(tx, routeId, businessId);

      if (!route) throw new RouteStatusConflictError();

      assertPlanVersion(route.planVersion, options.expectedPlanVersion);

      // The ceiling is counted under the lock, so two adds of 150 cannot
      // both pass a check made against the same 0 (D11).
      const open = await tx.routeStop.count({
        where: { routeId, status: { in: OPEN_STOP_STATUSES } },
      });

      if (open + deliveryIds.length > ROUTE_MAX_STOPS) {
        throw new RouteStopsLimitError(ROUTE_MAX_STOPS);
      }

      const highest = await tx.routeStop.aggregate({
        where: { routeId },
        _max: { sequence: true },
      });

      /**
       * One INSERT, not one per stop.
       *
       * The sequences are arithmetic — spaced by ten from the highest one
       * already on the route — so nothing here needs a round trip to decide
       * the next value. `createManyAndReturn` gives back the rows, which is
       * why this could not simply be `createMany`.
       */
      let sequence = highest._max.sequence;

      const rows = deliveryIds.map((deliveryId) => {
        sequence = nextSequence(sequence);

        return { routeId, deliveryId, sequence };
      });

      const created = (await tx.routeStop.createManyAndReturn({
        data: rows,
      })) as unknown as RouteStop[];

      // PENDING in the `where`, for the reason createRoute gives: a
      // delivery cancelled after the use case checked it must not become an
      // open stop. A short count rolls the whole batch back.
      const mirrored = await tx.delivery.updateMany({
        where: { id: { in: deliveryIds }, businessId, status: "PENDING" },
        data: { driverId: route.driverId, vehicleId: route.vehicleId },
      });

      if (mirrored.count !== new Set(deliveryIds).size) {
        throw new DeliveryNoLongerRoutableError();
      }

      const planVersion = await this.bumpPlanVersion(tx, routeId);

      await this.recordPlanEvents(
        tx,
        rows.map((row, index) => ({
          deliveryId: row.deliveryId,
          note: `Adicionada à Rota ${route.code} (parada ${open + index + 1}).`,
        })),
        { type: "ROUTE_ADDED", routeId, businessId, actorId: options.actorId },
      );

      return {
        stops: created,
        planVersion,
        status: route.status,
        driverId: route.driverId,
        code: route.code,
      };
    };

    try {
      return outerTx ? await run(outerTx) : await this.prisma.$transaction(run);
    } catch (error) {
      if (isDeliveryOnRoute(violatedIndex(error))) {
        throw new DeliveryAlreadyOnRouteError(deliveryIds.length);
      }

      throw error;
    }
  }

  async removeStops(
    routeId: string,
    businessId: string,
    stopIds: string[],
    options: PlanWriteOptions = {},
  ): Promise<PlanStopsRemoved> {
    return this.prisma.$transaction(async (tx) => {
      // The route row first, locked: a departure committing in between would
      // otherwise put this load on the street and then lose its stop and its
      // driver.
      const route = await this.lockEditableRoute(tx, routeId, businessId);

      if (!route) throw new RouteStatusConflictError();

      assertPlanVersion(route.planVersion, options.expectedPlanVersion);

      const wanted = [...new Set(stopIds)];

      // Only this route's stops, through the route's tenant, and only the
      // ones nobody worked yet: an ARRIVED stop is a record of a visit.
      const stops = await tx.routeStop.findMany({
        where: {
          id: { in: wanted },
          routeId,
          route: { businessId },
          status: "PENDING",
        },
        select: { id: true, deliveryId: true },
      });

      const found = new Set(stops.map((stop) => stop.id));
      const alreadyGone = wanted.filter((id) => !found.has(id));

      const base = {
        status: route.status,
        driverId: route.driverId,
        code: route.code,
      };

      if (stops.length === 0) {
        return {
          ...base,
          removed: [],
          alreadyGone,
          planVersion: route.planVersion,
          routeEmptied: false,
        };
      }

      await tx.routeStop.deleteMany({
        where: { id: { in: stops.map((stop) => stop.id) }, routeId },
      });

      // Back to the unassigned pool. Only the mirror is cleared — the delivery
      // keeps its own status, which removing it from a route never changed.
      await tx.delivery.updateMany({
        where: { id: { in: stops.map((stop) => stop.deliveryId) }, businessId },
        data: { driverId: null, vehicleId: null },
      });

      const planVersion = await this.bumpPlanVersion(tx, routeId);

      await this.recordPlanEvents(
        tx,
        stops.map((stop) => ({
          deliveryId: stop.deliveryId,
          note: `Retirada da Rota ${route.code} antes da saída.`,
        })),
        {
          type: "ROUTE_REMOVED",
          routeId,
          businessId,
          actorId: options.actorId,
        },
      );

      const remaining = await tx.routeStop.count({
        where: { routeId, status: { in: OPEN_STOP_STATUSES } },
      });

      return {
        ...base,
        removed: stops.map((stop) => ({
          stopId: stop.id,
          deliveryId: stop.deliveryId,
        })),
        alreadyGone,
        planVersion,
        routeEmptied: remaining === 0,
      };
    });
  }

  async reorderStops(
    routeId: string,
    businessId: string,
    orderedStopIds: string[],
    options: PlanWriteOptions = {},
  ): Promise<PlanReordered> {
    return this.prisma.$transaction(async (tx) => {
      // Locked: two reorders of the same route queue here instead of
      // interleaving their two-pass writes (last writer wins, or a deadlock
      // on the stop rows), and a departure in between is refused rather than
      // reordering a route already on the street.
      const route = await this.lockEditableRoute(tx, routeId, businessId);

      if (!route) throw new RouteStatusConflictError();

      assertPlanVersion(route.planVersion, options.expectedPlanVersion);

      const current = await tx.routeStop.findMany({
        where: { routeId },
        select: { id: true },
        orderBy: { sequence: "asc" },
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

      const base = {
        status: route.status,
        driverId: route.driverId,
        code: route.code,
      };

      // The order it already has: a retry after a lost answer, or a "Salvar"
      // with nothing moved. No write, no version, nobody woken up.
      if (current.every((stop, index) => stop.id === orderedStopIds[index])) {
        return { ...base, planVersion: route.planVersion, changed: false };
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

      const planVersion = await this.bumpPlanVersion(tx, routeId);

      return { ...base, planVersion, changed: true };
    });
  }

  async pinDeliveryLocation(
    deliveryId: string,
    businessId: string,
    point: { latitude: number; longitude: number } | null,
  ): Promise<PinnedLocation | null> {
    return this.prisma.$transaction(async (tx) => {
      // The route first, then the delivery: the order every route write
      // takes (route → stops → deliveries). Opposite orders deadlocked.
      const holder = await tx.routeStop.findFirst({
        where: {
          deliveryId,
          status: { in: OPEN_STOP_STATUSES },
          route: { businessId, status: { in: EDITABLE_STATUSES } },
        },
        select: { routeId: true },
      });

      const route = holder
        ? await this.lockEditableRoute(tx, holder.routeId, businessId)
        : null;

      const delivery = await tx.delivery.findFirst({
        where: { id: deliveryId, businessId },
        select: { status: true },
      });

      if (!delivery) return null;

      if (delivery.status === "DELIVERED" || delivery.status === "CANCELLED") {
        return { locked: true, delivery: null, route: null };
      }

      const updated = await tx.delivery.update({
        where: { id: deliveryId },
        data: point
          ? {
              latitude: point.latitude,
              longitude: point.longitude,
              geo_source: "MANUAL",
              geo_updated_at: new Date(),
            }
          : {
              latitude: null,
              longitude: null,
              geo_source: null,
              geo_updated_at: new Date(),
            },
        select: {
          id: true,
          latitude: true,
          longitude: true,
          geo_source: true,
          geo_updated_at: true,
        },
      });

      // The point is part of the plan the driver follows on a released
      // route, so the plan moves a version (decision 14.7, §4.11).
      const planVersion =
        route && holder ? await this.bumpPlanVersion(tx, holder.routeId) : null;

      return {
        locked: false,
        delivery: updated as PinnedLocation["delivery"],
        route:
          route && holder && planVersion !== null
            ? {
                routeId: holder.routeId,
                code: route.code,
                status: route.status,
                driverId: route.driverId,
                planVersion,
              }
            : null,
      };
    });
  }

  async findOpenStopRoutes(
    deliveryIds: string[],
    businessId: string,
  ): Promise<OpenStopRoute[]> {
    if (deliveryIds.length === 0) return [];

    const stops = await this.prisma.routeStop.findMany({
      where: {
        deliveryId: { in: [...new Set(deliveryIds)] },
        status: { in: OPEN_STOP_STATUSES },
        // The tenant sits on the route, which owns the stop.
        route: { businessId },
      },
      select: {
        id: true,
        deliveryId: true,
        route: { select: { id: true, code: true, status: true } },
      },
    });

    return stops.map((stop) => ({
      deliveryId: stop.deliveryId,
      stopId: stop.id,
      routeId: stop.route.id,
      routeCode: stop.route.code,
      routeStatus: stop.route.status,
    }));
  }

  async listVisitedPoints(
    routeId: string,
    businessId: string,
  ): Promise<VisitedPoint[]> {
    // The GPS the app captured at the door: arrival and proof, on THIS
    // route, of this company. Evidence, drawn next to the planned point.
    const events = await this.prisma.deliveryEvent.findMany({
      where: {
        routeId,
        businessId,
        type: { in: ["ARRIVAL", "PROOF"] },
        latitude: { not: null },
        longitude: { not: null },
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: {
        deliveryId: true,
        type: true,
        latitude: true,
        longitude: true,
        occurred_at: true,
        created_at: true,
      },
      take: 2 * ROUTE_MAX_STOPS,
    });

    return events.map((event) => ({
      deliveryId: event.deliveryId,
      type: event.type as VisitedPoint["type"],
      latitude: event.latitude as number,
      longitude: event.longitude as number,
      recordedAt: event.occurred_at ?? event.created_at,
    }));
  }

  async listUnroutedDeliveries(
    props: UnroutedDeliveriesQuery,
  ): Promise<UnroutedDeliveriesPage> {
    const facetWhere = (skip: UnroutedFacet | null) =>
      unroutedDeliveriesWhere(props, skip);

    const where = facetWhere(null);

    // The page and its count side by side, the four facets after them one
    // at a time: at most two of the replica's ten connections (the budget of
    // tests/E2E/connection-fan-out.test.ts). It took six at once.
    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: [
          { scheduled_date: { sort: "asc", nulls: "last" } },
          { created_at: "asc" },
          { id: "asc" },
        ],
        skip: (props.page - 1) * props.pageSize,
        take: props.pageSize,
        select: UNROUTED_DELIVERY_SELECT,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    const cities = await this.prisma.delivery.groupBy({
      by: ["city"],
      where: facetWhere("city"),
      _count: { _all: true },
      orderBy: { city: "asc" },
      take: UNROUTED_FACET_LIMIT,
    });

    const ufs = await this.prisma.delivery.groupBy({
      by: ["uf"],
      where: facetWhere("uf"),
      _count: { _all: true },
      orderBy: { uf: "asc" },
    });

    const kinds = await this.prisma.delivery.groupBy({
      by: ["kind"],
      where: facetWhere("kind"),
      _count: { _all: true },
      orderBy: { kind: "asc" },
    });

    // Every shipper with a count; cut and ordered by orderShipperFacet,
    // the same rule the in-memory twin applies.
    const shippers = await this.prisma.delivery.groupBy({
      by: ["shipperId"],
      where: facetWhere("shipper"),
      _count: { _all: true },
    });

    const shipperCounts = shippers
      .filter((row) => row.shipperId !== null)
      .map((row) => ({
        value: row.shipperId as string,
        count: row._count._all,
      }));

    // Names read through the tenant: an id is only ever named for its own
    // company.
    const names = new Map(
      (
        await this.prisma.shipper.findMany({
          where: {
            businessId: props.businessId,
            id: { in: shipperCounts.map((entry) => entry.value) },
          },
          select: { id: true, name: true },
        })
      ).map((shipper) => [shipper.id, shipper.name]),
    );

    return {
      data: rows as unknown as UnroutedDeliveryRow[],
      total,
      facets: {
        city: cities.map((row) => ({
          value: row.city,
          count: row._count._all,
        })),
        uf: ufs.map((row) => ({ value: row.uf, count: row._count._all })),
        kind: kinds.map((row) => ({ value: row.kind, count: row._count._all })),
        shipper: orderShipperFacet(shipperCounts, (id) => names.get(id)),
      },
    };
  }

  async listDepartedDeliveries(
    routeId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RouteStopWithDelivery["delivery"][]> {
    const stops = await (tx ?? this.prisma).routeStop.findMany({
      where: {
        routeId,
        status: { in: OPEN_STOP_STATUSES },
        route: { businessId },

        // What the departure's mirror moved. A delivery cancelled (or already
        // resolved) while its stop waited stays out of "saiu para entrega".
        delivery: { status: "IN_TRANSIT" },
      },
      orderBy: { sequence: "asc" },
      select: {
        delivery: { select: routeInclude.stops.include.delivery.select },
      },
    });

    return stops.map(
      (stop) => stop.delivery as unknown as RouteStopWithDelivery["delivery"],
    );
  }

  async countRoutesReferencing(reference: {
    driverId?: string;
    vehicleId?: string;
  }): Promise<number> {
    return this.prisma.route.count({
      where: {
        ...(reference.driverId && { driverId: reference.driverId }),
        ...(reference.vehicleId && { vehicleId: reference.vehicleId }),
      },
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
      releaseDelivery?: boolean;
      onPlanDropped?: (bump: PlanBump) => void;
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

  async lockRouteOfOpenStop(
    deliveryId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    // FOR UPDATE, the mode settleWithin takes a moment later, so the second
    // lock in the same transaction is already held. If a cancellation got
    // the route first this waits for it, and once it commits the route is
    // no longer live: the row drops out (Postgres re-checks the locked row's
    // conditions) and the caller's own conditional write finds the delivery
    // already released.
    //
    // A route that has not left yet counts too (IDEMP-11): an outcome for a
    // delivery on a plan takes its stop off that plan (dropFromUnstartedRoute),
    // and removeStop/detach/the departure lock that route before touching the
    // delivery — so this transaction must reach it first as well, or the two
    // orders cycle.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r."id"
      FROM "route" r
      JOIN "route_stop" s ON s."routeId" = r."id"
      WHERE s."deliveryId" = ${deliveryId}
        AND s."status" IN ('PENDING', 'ARRIVED')
        AND r."businessId" = ${businessId}
        AND r."status" IN ('PLANNED', 'RELEASED', 'IN_PROGRESS')
      FOR UPDATE OF r
    `;

    return rows[0]?.id ?? null;
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
      releaseDelivery?: boolean;
      onPlanDropped?: (bump: PlanBump) => void;
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

    if (!target) {
      // Not on a running route. If the delivery is DONE with (a terminal
      // outcome) and still sits on a plan that has not left, the plan lets it
      // go — see dropFromUnstartedRoute. An arrival changes nothing here, and
      // neither does a return to pending (`releaseDelivery`): that is a load
      // coming back off the street, and on a plan nothing left. It is the
      // dispatcher undoing a mistaken "Em rota", and PENDING on the plan is
      // exactly where the document was before — dropping it there took it off
      // tomorrow's route and the driver's phone without a word.
      if (outcome.status !== "ARRIVED" && !outcome.releaseDelivery) {
        const bump = await this.dropFromUnstartedRoute(
          client,
          deliveryId,
          businessId,
        );

        if (bump) outcome.onPlanDropped?.(bump);
      }

      return null;
    }

    // Settles of one route queue behind each other, held until this commit.
    //
    // Without it the last two stops settled at the same instant each counted
    // the OTHER as still open — neither sees an uncommitted sibling under
    // READ COMMITTED — and neither closed the route: IN_PROGRESS forever,
    // truck "Em rota", `route.completed` never sent. With it, the second waits
    // here, and its count (a fresh snapshot per statement) sees the first.
    //
    // Lock order: every transaction that writes a delivery on a running
    // route and settles its stop takes this route row FIRST, through
    // lockRouteOfOpenStop, before touching the delivery. A cancellation takes
    // route → stops → deliveries, so both start at the route and never
    // cycle. (They used to take delivery → route here, and the overlap with a
    // cancellation ended in a 40P01 that the operator saw as a 500.) Here the
    // lock is normally already held; it still serialises a caller that did
    // not take it, such as the arrival, which does not write the delivery.
    await client.$queryRaw`
      SELECT 1 FROM "route"
      WHERE "id" = ${target.routeId} AND "businessId" = ${businessId}
      FOR UPDATE
    `;

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

    // Back to the pool (a load returned to base while the route runs): the
    // shadow goes with the stop, so the delivery leaves the driver's phone and
    // can join another route. Same write removeStop makes.
    if (outcome.releaseDelivery) {
      await client.delivery.updateMany({
        where: { id: deliveryId, businessId },
        data: { driverId: null, vehicleId: null },
      });
    }

    const stop = await client.routeStop.findUniqueOrThrow({
      where: { id: target.id },
    });

    return {
      stop: stop as unknown as RouteStop,
      closedRoute: await this.closeIfFinished(
        client,
        target.routeId,
        businessId,
        // The fact that resolved this stop, so a route closed by a proof
        // uploaded hours late ends when the work did (MOB-08).
        outcome.completed_at,
      ),
    };
  }

  /**
   * A delivery that reached an outcome while its stop sits on a route that
   * has NOT left (PLANNED or RELEASED): the stop comes off the plan, the way
   * removeStop takes it off, and the shadow is cleared.
   *
   * Settling only ever looked at running routes, so a delivery cancelled on
   * the panel the evening before kept its open stop: the departure carried it
   * onto the street, nobody could ever resolve it, and the route never closed
   * — the truck "Em rota" until somebody cancelled a route that had been
   * fully worked. A plan has no history to keep, so the stop is deleted
   * rather than given an outcome (an outcome would also block pulling the
   * route back to planning).
   *
   * The plan changed, so its version moves (D5) and the trail says why; the
   * bump is answered so the caller can tell the screens after its commit.
   */
  private async dropFromUnstartedRoute(
    client: Prisma.TransactionClient,
    deliveryId: string,
    businessId: string,
  ): Promise<PlanBump | null> {
    const open = await client.routeStop.findFirst({
      where: {
        deliveryId,
        status: { in: OPEN_STOP_STATUSES },
        route: { businessId, status: { in: EDITABLE_STATUSES } },
      },
      select: { id: true, routeId: true },
    });

    if (!open) return null;

    // Normally already held (lockRouteOfOpenStop, first in the caller's
    // transaction); re-checked, because a departure may have won the row.
    if (!(await this.lockEditableRoute(client, open.routeId, businessId))) {
      return null;
    }

    const removed = await client.routeStop.deleteMany({
      where: { id: open.id, status: { in: OPEN_STOP_STATUSES } },
    });

    if (removed.count === 0) return null;

    await client.delivery.updateMany({
      where: { id: deliveryId, businessId },
      data: { driverId: null, vehicleId: null },
    });

    const [bump] = await this.bumpPlanVersions(
      [open.routeId],
      businessId,
      client,
    );

    if (!bump) return null;

    await this.recordPlanEvents(
      client,
      [
        {
          deliveryId,
          note: `Retirada da Rota ${bump.code}: a entrega foi encerrada.`,
        },
      ],
      {
        type: "ROUTE_REMOVED",
        routeId: open.routeId,
        businessId,
        actorId: null,
      },
    );

    return bump;
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
    closingAt?: Date,
  ): Promise<Route | null> {
    const stillOpen = await client.routeStop.count({
      where: { routeId, status: { in: OPEN_STOP_STATUSES } },
    });

    if (stillOpen > 0) return null;

    const completedAt = await this.completionTime(
      client,
      routeId,
      businessId,
      closingAt,
    );

    const closed = await client.route.updateMany({
      where: { id: routeId, businessId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completed_at: completedAt },
    });

    // Idempotent: a resend finds the route already closed and answers null
    // rather than failing.
    if (closed.count === 0) return null;

    const route = await client.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    // The route ended by itself, so the truck came back by itself too.
    await this.syncVehicleStatus(client, route as unknown as Route);

    return route as unknown as Route;
  }

  /**
   * The route's completed_at, by the time of the facts (routeCompletedAt).
   *
   * Without a closing time there is nothing to date the close by, and it is
   * "now" with no query, as it always was. With one, the other stops are
   * read too: a cancelled stop has no completed_at, and its updated_at is
   * when it was called off. Runs once per route, at its close.
   */
  private async completionTime(
    client: Prisma.TransactionClient,
    routeId: string,
    businessId: string,
    closingAt?: Date,
  ): Promise<Date> {
    const now = new Date();

    if (!closingAt) return now;

    const [row] = await client.$queryRaw<
      Array<{ started_at: Date | null; last_resolved_at: Date | null }>
    >`
      SELECT r."started_at",
        (
          SELECT max(coalesce(s."completed_at", s."updated_at"))
          FROM "route_stop" s
          WHERE s."routeId" = r."id"
        ) AS "last_resolved_at"
      FROM "route" r
      WHERE r."id" = ${routeId} AND r."businessId" = ${businessId}
    `;

    return routeCompletedAt({
      closingAt,
      lastResolvedAt: row?.last_resolved_at ?? null,
      startedAt: row?.started_at ?? null,
      now,
    });
  }
}

export { RouteRepository };
