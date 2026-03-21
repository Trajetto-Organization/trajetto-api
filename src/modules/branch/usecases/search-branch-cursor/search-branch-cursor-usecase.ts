import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBranchRepository } from "../../repositories/IBranch-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedBranch } from "../../dtos/branch-dto";
import { AppError } from "@/shared/errors/AppError";

interface SearchBranchWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
}

@injectable()
class SearchBranchCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
  }: SearchBranchWithCursorRequest): Promise<CursorPaginatedBranch> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.branch.searchBranchWithCursor({
        limit,
        cursor,
        businessId,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de filiais por empresa!",
        500,
      );
    }
  }
}

export { SearchBranchCursorUseCase };
