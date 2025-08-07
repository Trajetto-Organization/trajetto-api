import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "../../repositories/IFuel-type-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { ListFuelTypeProps } from "../../dtos/fuel-type-dto";

@injectable()
class ListFuelTypeBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListFuelTypeProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const fuelTypeList = await this.fuelType.listFuelTypeBusiness({
        page,
        pageSize,
        businessId,
      });

      return fuelTypeList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de combustíveis por empresa!",
        500,
      );
    }
  }
}

export { ListFuelTypeBusinessUseCase };
