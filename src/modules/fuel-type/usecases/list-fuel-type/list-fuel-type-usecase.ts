import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListFuelTypeProps } from "../../dtos/fuel-type-dto";

@injectable()
class ListFuelTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListFuelTypeProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const fuelTypes = await this.fuelType.listFuelTypes({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return fuelTypes;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os tipos de combustível! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelTypeUseCase };
