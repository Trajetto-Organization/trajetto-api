import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelTypeRepository } from "../../repositories/IFuel-type-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedFuelType } from "../../dtos/fuel-type-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchFuelTypeWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

@injectable()
class SearchFuelTypeCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchFuelTypeWithCursorRequest): Promise<CursorPaginatedFuelType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.fuelType.searchFuelTypeWithCursor({
        limit,
        cursor,
        businessId,
        search,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de combustíveis por empresa!",
        500,
      );
    }
  }
}

export { SearchFuelTypeCursorUseCase };
