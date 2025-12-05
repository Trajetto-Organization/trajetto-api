import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListAccountPayableProps } from "../../dtos/account-payable-dto";

@injectable()
class ListAccountPayableUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListAccountPayableProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const accountPayables = await this.accountPayable.listAccountPayables({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return accountPayables;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as contas para pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListAccountPayableUseCase };
