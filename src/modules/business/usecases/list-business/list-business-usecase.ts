import { inject, injectable } from "tsyringe";
import { Business } from "../../dtos/business-dto";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "../../repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<{ data: Business[]; total: number }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.business.listBusiness({
        page,
        pageSize,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
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

export { ListBusinessUseCase };
