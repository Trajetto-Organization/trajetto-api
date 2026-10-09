import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IDriverRepository } from "../../repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedDriver } from "../../dtos/driver-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { DriverPickerAccess } from "./driver-picker-access";

interface SearchDriverWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  search?: string;
  /** What the caller may see: the catalogue row or the dispatcher's choice. */
  projection?: DriverPickerAccess;
}

@injectable()
class SearchDriverCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
    projection = "catalog",
  }: SearchDriverWithCursorRequest): Promise<CursorPaginatedDriver> {
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
      const result = await this.driver.searchDriverWithCursor({
        limit,
        cursor,
        businessId,
        search,
        projection,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de motoristas por empresa!",
        500,
      );
    }
  }
}

export { SearchDriverCursorUseCase };
