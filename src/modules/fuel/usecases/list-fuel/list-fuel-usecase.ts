import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListFuelProps } from "../../dtos/fuel-dto";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListFuelUseCase {
  constructor(
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListFuelProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const fuels = await this.fuel.listFuels({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });
      return fuels;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelUseCase };
