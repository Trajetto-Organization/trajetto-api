import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListFuelProps, ListFuelBusinessProps } from "../../dtos/fuel-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListFuelBusinessUseCase {
  constructor(
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    listFuelBusinessProps: ListFuelBusinessProps,
    userId: string,
  ): Promise<ListFuelProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      listFuelBusinessProps.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const fuels = await this.fuel.listFuelBusiness(listFuelBusinessProps);
      return fuels;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de abastecimentos por empresa!",
        500,
      );
    }
  }
}

export { ListFuelBusinessUseCase };
