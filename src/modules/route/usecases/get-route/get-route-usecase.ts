import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { routeProgress } from "@/shared/route/route-rules";

import { RouteNotFoundError } from "../errors/route-errors";

import {
  routeDriverPosition,
  type RouteDriverPosition,
} from "./route-driver-position";

import type { RouteWithStops, VisitedPoint } from "../../dtos/route-dto";

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
  ) {}

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

    // The driver's app reads its own route; it has no map to feed.
    if (findUser.driverId) {
      return {
        route: findRoute,
        progress,
        driverPosition: null,
        visitedPoints: [],
      };
    }

    const [last, visitedPoints] = await Promise.all([
      findRoute.status === "RELEASED" || findRoute.status === "IN_PROGRESS"
        ? this.positions.findLast(businessId, findRoute.driverId)
        : Promise.resolve(null),
      this.route.listVisitedPoints(routeId, businessId),
    ]);

    return {
      route: findRoute,
      progress,
      driverPosition: routeDriverPosition(findRoute, last),
      visitedPoints,
    };
  }
}

export { GetRouteUseCase };
export type { GetRouteRequest, GetRouteResult };
