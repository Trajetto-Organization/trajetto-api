import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { routeProgress } from "@/shared/route/route-rules";

import { RouteNotFoundError } from "../errors/route-errors";

import type { RouteWithStops } from "../../dtos/route-dto";

interface GetRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;
}

interface GetRouteResult {
  route: RouteWithStops;

  /** Worked / total, so the panel does not recount the stops itself. */
  progress: ReturnType<typeof routeProgress>;
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

    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    // A driver opens their own routes and nobody else's. Same 404: the driver
    // of the next truck must not be able to read today's plan by guessing.
    if (findUser.driverId && findRoute.driverId !== findUser.driverId) {
      throw new AppError(new RouteNotFoundError().message, 404);
    }

    return {
      route: findRoute,
      progress: routeProgress(findRoute.stops.map((stop) => stop.status)),
    };
  }
}

export { GetRouteUseCase };
export type { GetRouteRequest, GetRouteResult };
