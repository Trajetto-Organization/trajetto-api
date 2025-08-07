import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ProfileAccess } from "../../dtos/profile-access-dto";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListProfileBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<{ data: ProfileAccess[]; total: number }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.profileAccess.listProfileBusiness({
        page,
        pageSize,
        businessId,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de perfis por empresa!",
        500,
      );
    }
  }
}

export { ListProfileBusinessUseCase };
