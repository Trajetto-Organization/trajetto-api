import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import type {
  UnroutedDeliveriesPage,
  UnroutedDeliveriesQuery,
} from "./unrouted-deliveries";

type ListUnroutedDeliveriesRequest = UnroutedDeliveriesQuery & {
  userId: string;
};

/**
 * The "Adicionar entregas" picker of the route page (decision 14.7, §5.5):
 * the company's PENDING deliveries that sit on no open stop — exactly the
 * ones a route can still take.
 *
 * A dispatcher's read: a driver token is refused like every planning call,
 * since the list names other people's addresses.
 */
@injectable()
class ListUnroutedDeliveriesUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    ...query
  }: ListUnroutedDeliveriesRequest): Promise<UnroutedDeliveriesPage> {
    await assertRouteDispatcher(this.user, userId, query.businessId);

    return this.route.listUnroutedDeliveries(query);
  }
}

export { ListUnroutedDeliveriesUseCase };
