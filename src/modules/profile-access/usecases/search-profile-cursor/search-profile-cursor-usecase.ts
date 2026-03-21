import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedProfileAccess } from "../../dtos/profile-access-dto";
import { AppError } from "@/shared/errors/AppError";

interface SearchProfileAccessWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
}

@injectable()
class SearchProfileCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
  }: SearchProfileAccessWithCursorRequest): Promise<CursorPaginatedProfileAccess> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.profileAccess.searchProfileAccessWithCursor({
        limit,
        cursor,
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

export { SearchProfileCursorUseCase };
