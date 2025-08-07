import { inject, injectable } from "tsyringe";

import { IDriverRepository } from "../../repositories/IDriver-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListDriverProps } from "../../dtos/driver-dto";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

@injectable()
class ListDriverBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListDriverProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const driverList = await this.driver.listDriverBusiness({
        page,
        pageSize,
        businessId,
      });

      return driverList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de motoristas por empresa!",
        500,
      );
    }
  }
}

export { ListDriverBusinessUseCase };
