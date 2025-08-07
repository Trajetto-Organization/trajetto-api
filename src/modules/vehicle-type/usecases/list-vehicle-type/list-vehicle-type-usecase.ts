import { inject, injectable } from "tsyringe";
import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListVehicleTypeProps } from "../../dtos/vehicle-type-dto";

@injectable()
class ListVehicleTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListVehicleTypeProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const vehicleTypes = await this.vehicleType.listVehicleTypes({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return vehicleTypes;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os tipos de veículos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleTypeUseCase };
