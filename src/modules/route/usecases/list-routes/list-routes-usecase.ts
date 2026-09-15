import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";

import type { RouteStatus } from "@/shared/route/route-rules";
import type { ListRoutesResult } from "../../dtos/route-dto";

interface ListRoutesRequest {
  userId: string;
  businessId?: string;

  page: number;
  pageSize: number;

  status?: RouteStatus;
  driverId?: string;
  scheduled_date?: Date;
  search?: string;
}

/**
 * The dispatcher's board: every route of the company, newest first.
 *
 * A driver user asking for this gets only their own routes, whatever they put
 * in `driverId` — the app never lists the whole operation to the person
 * executing one slice of it. The override is not a filter the client can
 * widen: the user's own driver id replaces whatever was sent.
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
    page,
    pageSize,
    status,
    driverId,
    scheduled_date,
    search,
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
      businessId: resolvedBusinessId,
      page,
      pageSize,
      status,
      driverId: findUser.driverId ?? driverId,
      scheduled_date,
      search,
    });
  }
}

export { ListRoutesUseCase };
export type { ListRoutesRequest };
