import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPartRepository } from "../../repositories/IPart-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListPartProps } from "../../dtos/part-dto";

@injectable()
class ListPartBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PartRepository")
    private part: IPartRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListPartProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const partList = await this.part.listPartBusiness({
        page,
        pageSize,
        businessId,
      });

      return partList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de peças por empresa!",
        500,
      );
    }
  }
}

export { ListPartBusinessUseCase };
