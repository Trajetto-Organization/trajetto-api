import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListVehicleProps } from "../../dtos/vehicle-dto";

@injectable()
class ListVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListVehicleProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const vehicles = await this.vehicle.listVehicles({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return vehicles;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os veículos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleUseCase };
