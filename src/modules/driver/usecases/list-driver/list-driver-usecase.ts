import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListDriverProps } from "../../dtos/driver-dto";

@injectable()
class ListDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListDriverProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const drivers = await this.driver.listDrivers({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return drivers;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os motoristas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListDriverUseCase };
