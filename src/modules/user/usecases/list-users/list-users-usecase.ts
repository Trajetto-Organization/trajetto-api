import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ListUsers } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListUsersUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListUsers> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.user.listUsers({
        page,
        pageSize,
        search,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        currentUserId: findUser.id,
      });
      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de usuários!",
        500,
      );
    }
  }
}

export { ListUsersUseCase };
