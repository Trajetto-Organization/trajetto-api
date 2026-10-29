import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IVehicleTypeRepository } from "../../repositories/IVehicle-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedVehicleType } from "../../dtos/vehicle-type-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchVehicleTypeWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  /** The typed term, filtered on the server (FLEET-SEARCH-1). */
  search?: string;
}

@injectable()
class SearchVehicleTypeCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchVehicleTypeWithCursorRequest): Promise<CursorPaginatedVehicleType> {
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
      return await this.vehicleType.searchVehicleTypeWithCursor({
        limit,
        cursor,
        businessId,
        search,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de tipos de veículos por empresa!",
        500,
      );
    }
  }
}

export { SearchVehicleTypeCursorUseCase };
