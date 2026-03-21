import { inject, injectable } from "tsyringe";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { Business } from "../../dtos/business-dto";
import { AppError } from "@/shared/errors/AppError";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

@injectable()
class DeleteBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(businessId: string, userId: string): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const businessDeleted = await this.business.deleteBusiness(businessId);
      return businessDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteBusinessUseCase };
