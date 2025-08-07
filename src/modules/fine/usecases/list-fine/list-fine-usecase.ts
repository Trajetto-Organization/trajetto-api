import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const fines = await this.fine.listFines({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return fines;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as multas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFineUseCase };
