import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListAccountPayableProps } from "../../dtos/account-payable-dto";

@injectable()
class ListAccountPayableByResponsibleUserUseCase {
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
  ): Promise<ListAccountPayableProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const accountPayables =
        await this.accountPayable.listAccountPayablesByResponsibleUserId({
          page,
          pageSize,
          responsibleUserId: userId,
          businessId: findUser.businessId as string,
        });

      return accountPayables;
    } catch (error) {
      console.log(
        "Erro ao listar account payables por responsibleUserId",
        error,
      );

      throw new AppError(
        "Houve um erro ao tentar listar suas contas a pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListAccountPayableByResponsibleUserUseCase };
