import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { CursorPaginatedAccountPayable } from "../../dtos/account-payable-dto";
import { AppError } from "@/shared/errors/AppError";

interface SearchAccountPayableCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
}

@injectable()
class SearchAccountPayableCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
  }: SearchAccountPayableCursorRequest): Promise<CursorPaginatedAccountPayable> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result =
        await this.accountPayable.searchAccountPayableByResponsibleUserWithCursor(
          {
            limit,
            cursor,
            businessId: findUser.businessId as string,
            userId,
          },
        );

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de contas a pagar!",
        500,
      );
    }
  }
}

export { SearchAccountPayableCursorUseCase };
