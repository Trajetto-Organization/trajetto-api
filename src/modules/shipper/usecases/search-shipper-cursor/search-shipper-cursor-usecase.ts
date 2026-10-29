import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";

import { CursorPaginatedShipper } from "../../dtos/shipper-dto";
import { AppError } from "@/shared/errors/AppError";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchShipperWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

@injectable()
class SearchShipperCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchShipperWithCursorRequest): Promise<CursorPaginatedShipper> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw businessNotFound();
    }

    try {
      return await this.shipper.searchShipperWithCursor({
        limit,
        cursor,
        businessId,
        search,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar os embarcadores!", 500);
    }
  }
}

export { SearchShipperCursorUseCase };
