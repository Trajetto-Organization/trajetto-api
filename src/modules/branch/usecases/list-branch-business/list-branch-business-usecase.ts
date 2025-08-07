import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "../../repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListBranchProps } from "../../dtos/branch-dto";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

@injectable()
class ListBranchBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListBranchProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const supplierList = await this.branch.listBranchBusiness({
        page,
        pageSize,
        businessId,
      });

      return supplierList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de filiais por empresa!",
        500,
      );
    }
  }
}

export { ListBranchBusinessUseCase };
