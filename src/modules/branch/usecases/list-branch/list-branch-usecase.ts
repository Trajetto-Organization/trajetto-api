import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListBranchProps } from "../../dtos/branch-dto";

@injectable()
class ListBranchUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListBranchProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const branchList = await this.branch.listAllBranches({
        page,
        pageSize,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        search,
      });

      return branchList;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as filiais! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListBranchUseCase };
