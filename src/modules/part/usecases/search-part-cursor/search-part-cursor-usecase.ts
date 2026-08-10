import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IPartRepository } from "../../repositories/IPart-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedPart } from "../../dtos/part-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchPartWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
}

@injectable()
class SearchPartCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PartRepository")
    private part: IPartRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
  }: SearchPartWithCursorRequest): Promise<CursorPaginatedPart> {
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
      const result = await this.part.searchPartWithCursor({
        limit,
        cursor,
        businessId,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de peças por empresa!",
        500,
      );
    }
  }
}

export { SearchPartCursorUseCase };
