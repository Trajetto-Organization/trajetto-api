import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedProfileAccess } from "../../dtos/profile-access-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchProfileAccessWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
  /** The typed term, matched against the profile name. */
  search?: string;
  /**
   * Only the profiles the asker may change the permissions of: a
   * BUSINESS_USER's own profile is left out, as the profile and permission
   * lists already do. Off for the user form, where giving a colleague the
   * same profile is legitimate.
   */
  editable?: boolean;
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
    search,
    editable = false,
  }: SearchProfileAccessWithCursorRequest): Promise<CursorPaginatedProfileAccess> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.profileAccess.searchProfileAccessWithCursor({
        limit,
        cursor,
        businessId,
        search,
        hideProfileId:
          editable && findUser.role === "BUSINESS_USER"
            ? findUser.profileAccessId
            : null,
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
