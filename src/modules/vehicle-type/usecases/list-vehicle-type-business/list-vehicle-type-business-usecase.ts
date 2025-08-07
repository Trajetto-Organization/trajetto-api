import { inject, injectable } from "tsyringe";

import { IVehicleTypeRepository } from "../../repositories/IVehicle-type-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListVehicleTypeProps } from "../../dtos/vehicle-type-dto";

@injectable()
class ListVehicleTypeBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListVehicleTypeProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const vehicleTypeList = await this.vehicleType.listVehicleTypeBusiness({
        page,
        pageSize,
        businessId,
      });

      return vehicleTypeList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de tipos dos veículos por empresa!",
        500,
      );
    }
  }
}

export { ListVehicleTypeBusinessUseCase };
