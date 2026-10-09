import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";

import type { SortOrder } from "@/shared/pagination/list-query";
import type { RouteStatus } from "@/shared/route/route-rules";
import type { ListRoutesResult } from "../../dtos/route-dto";
import type { RouteSortKey } from "./route-list";

interface ListRoutesRequest {
  userId: string;
  businessId?: string;

  page: number;
  pageSize: number;

  sort?: RouteSortKey;
  order?: SortOrder;

  statuses?: RouteStatus[];
  driverIds?: string[];
  vehicleIds?: string[];
  scheduled_date?: Date;
  search?: string;
}

/**
 * The dispatcher's board: every route of the company, newest first unless
 * the table asks for another order, with its filters and cards answered over
 * the whole company (decision 8.8).
 *
 * A driver user asking for this gets only their own routes, whatever they put
 * in `driverId` — the app never lists the whole operation to the person
 * executing one slice of it. The scope is not a filter the client can widen:
 * the user's own driver id replaces whatever driver facet was sent.
 */
@injectable()
class ListRoutesUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    businessId,
    ...query
  }: ListRoutesRequest): Promise<ListRoutesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    // MASTER picks the company explicitly; everyone else is pinned to their
    // own — the same resolution every list route in the app uses.
    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    return this.route.listRoutes({
      ...query,
      businessId: resolvedBusinessId,
      ...(findUser.driverId && {
        scopeDriverId: findUser.driverId,
        driverIds: undefined,
      }),
    });
  }
}

export { ListRoutesUseCase };
export type { ListRoutesRequest };
