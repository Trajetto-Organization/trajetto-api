import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";
import {
  checklistsByRoute,
  type MyDeliveriesRoute,
} from "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase";

import { routeProgress } from "@/shared/route/route-rules";
import {
  loadBusinessTimeZone,
  type BusinessLookup,
} from "@/shared/time/business-time-zone";

import { RouteNotFoundError } from "../errors/route-errors";

import {
  routeDriverPosition,
  type RouteDriverPosition,
} from "./route-driver-position";

import type {
  RouteWithStops,
  StopGeofenceFlag,
  VisitedPoint,
} from "../../dtos/route-dto";
import type { RouteFuelSummary } from "@/modules/fuel/dtos/fuel-dto";

interface GetRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;
}

interface GetRouteResult {
  route: RouteWithStops;

  /** Worked / total, so the panel does not recount the stops itself. */
  progress: ReturnType<typeof routeProgress>;

  /**
   * The route map's live layers (decision 14.7, §4.2): the driver's dot on
   * THIS route, and the GPS captured at the stops already worked. Only for
   * the panel — the driver's own read skips both.
   */
  driverPosition: RouteDriverPosition | null;
  visitedPoints: VisitedPoint[];

  /**
   * The stops recorded outside the radius (E5): the newest OUTSIDE arrival,
   * proof or occurrence of each. The occurrence is not a map point, so the
   * stop card cannot read it from `visitedPoints`. Panel only.
   */
  stopGeofence: StopGeofenceFlag[];

  /**
   * The company's zone (plan of 02/11/2026, G8; decision D22): the panel
   * prints every time of the route on the company's clock, with the note,
   * as the tower does — not on the browser's.
   */
  timeZone: string;

  /**
   * What happened to the vehicle on the route (plan of 02/11/2026, F3): the
   * newest departure and arrival checklists — the shape the driver's
   * payload carries (C4) — and the refuellings made on it. Null when this
   * reader may not see them: FLEET off, or a profile without the key of the
   * screen that lists them (Checklists, Abastecimentos).
   */
  checklists: MyDeliveriesRoute["checklists"] | null;
  fuels: RouteFuelSummary[] | null;
}

/**
 * One route, with its stops in the dispatcher's order and the deliveries
 * behind them — the detail screen, and the payload the driver's app opens.
 *
 * Every refusal here is 404, including a route that exists but belongs to
 * another company or another driver. A distinct "exists but is not yours"
 * would let anyone with a token learn which ids are real, one request at a
 * time.
 */
@injectable()
class GetRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
    @inject("BusinessRepository")
    private business: BusinessLookup,
    @inject("VehicleChecklistRepository")
    private checklists: IVehicleChecklistRepository,
    @inject("FuelRepository")
    private fuels: IFuelRepository,
  ) {}

  /**
   * The route's fleet records, for whoever may read them (F3). The module
   * first — FLEET off hides every screen of it, and the route page must not
   * reopen one — then each record behind the key of its own screen. A driver
   * passes through the app's fixed table: these are their own records.
   */
  private async vehicleRecords(
    user: PermissionPrincipal,
    businessId: string,
    routeId: string,
  ): Promise<Pick<GetRouteResult, "checklists" | "fuels">> {
    const readsChecklists = !decidePermission(
      user,
      "vehicle_checklist_manage",
      "read",
    );
    const readsFuels = !decidePermission(user, "fuel_manage", "read");

    if (!readsChecklists && !readsFuels) {
      return { checklists: null, fuels: null };
    }

    if (!(await this.route.assignmentContext(businessId)).fleetEnabled) {
      return { checklists: null, fuels: null };
    }

    const checklists = readsChecklists
      ? (checklistsByRoute(
          await this.checklists.listRouteChecklists(businessId, [routeId]),
        ).get(routeId) ?? { route_start: null, route_end: null })
      : null;

    const fuels = readsFuels
      ? await this.fuels.listRouteFuels(businessId, routeId)
      : null;

    return { checklists, fuels };
  }

  async execute({
    userId,
    businessId,
    routeId,
  }: GetRouteRequest): Promise<GetRouteResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    // The read is already scoped by company, so a route of another carrier
    // comes back null rather than coming back and being rejected.
    const findRoute = await this.route.findRouteById(routeId, businessId);

    if (!findRoute) throw new RouteNotFoundError();

    // A driver opens their own routes and nobody else's. Same 404: the driver
    // of the next truck must not be able to read today's plan by guessing.
    if (findUser.driverId && findRoute.driverId !== findUser.driverId) {
      throw new RouteNotFoundError();
    }

    const progress = routeProgress(findRoute.stops.map((stop) => stop.status));
    const timeZone = await loadBusinessTimeZone(this.business, businessId);

    const records = await this.vehicleRecords(
      findUser as PermissionPrincipal,
      businessId,
      routeId,
    );

    // The driver's app reads its own route; it has no map to feed.
    if (findUser.driverId) {
      return {
        route: findRoute,
        progress,
        driverPosition: null,
        visitedPoints: [],
        stopGeofence: [],
        timeZone,
        ...records,
      };
    }

    const [last, visitedPoints] = await Promise.all([
      findRoute.status === "RELEASED" || findRoute.status === "IN_PROGRESS"
        ? this.positions.findLast(businessId, findRoute.driverId)
        : Promise.resolve(null),
      this.route.listVisitedPoints(routeId, businessId),
    ]);

    // After the two above, never beside them: two connections at most.
    const stopGeofence = await this.route.listStopGeofence(routeId, businessId);

    return {
      route: findRoute,
      progress,
      driverPosition: routeDriverPosition(findRoute, last),
      visitedPoints,
      stopGeofence,
      timeZone,
      ...records,
    };
  }
}

export { GetRouteUseCase };
export type { GetRouteRequest, GetRouteResult };
