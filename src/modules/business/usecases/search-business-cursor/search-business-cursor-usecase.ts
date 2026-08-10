import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "../../repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { CursorPaginatedBusiness } from "../../dtos/business-dto";

import { AppError } from "@/shared/errors/AppError";

interface SearchBusinessWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  search?: string;
}

@injectable()
class SearchBusinessCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    search,
  }: SearchBusinessWithCursorRequest): Promise<CursorPaginatedBusiness> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.business.searchBusinessWithCursor({
        limit,
        cursor,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de empresas!",
        500,
      );
    }
  }
}

export { SearchBusinessCursorUseCase };
