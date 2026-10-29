import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IServiceOrderRepository } from "../../repositories/IService-order-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedServiceOrder } from "../../dtos/service-order-dto";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchServiceOrderCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  /** The picker's typed term (FLEET-SEARCH-1). */
  search?: string;
}

@injectable()
class SearchServiceOrderCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchServiceOrderCursorRequest): Promise<CursorPaginatedServiceOrder> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.serviceOrder.searchServiceOrderWithCursor({
        limit,
        cursor,
        businessId,
        search,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de ordens de serviço por empresa!",
        500,
      );
    }
  }
}

export { SearchServiceOrderCursorUseCase };
