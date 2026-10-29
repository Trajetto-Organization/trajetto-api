import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import type { OpenStopRoute } from "../../dtos/route-dto";

/**
 * Where a selection of deliveries is now: which route holds each one.
 *
 * What the "Adicionar à rota" dialog of the deliveries table asks before it
 * confirms (decision 14.7, §5.6): "3 já estão na Rota 9 e serão movidas", or
 * "1 está numa rota que já saiu". Read through the route's tenant, so a
 * foreign id simply has no answer.
 */
@injectable()
class ListOpenStopsUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryIds,
  }: {
    userId: string;
    businessId: string;
    deliveryIds: string[];
  }): Promise<OpenStopRoute[]> {
    await assertRouteDispatcher(this.user, userId, businessId);

    return this.route.findOpenStopRoutes(deliveryIds, businessId);
  }
}

export { ListOpenStopsUseCase };
