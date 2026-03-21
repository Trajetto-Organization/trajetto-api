import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { ListUsers } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListMasterUsersUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute(
    page: number,
    pageSize: number,
    search?: string,
    currentUserId?: string,
  ): Promise<ListUsers> {
    const findUser = await this.user.findUserById(currentUserId as string);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const masterUsers = await this.user.listMasterUsers({
        page,
        pageSize,
        search,
        currentUserId: findUser.id,
      });

      return masterUsers;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de usuários!",
        500,
      );
    }
  }
}

export { ListMasterUsersUseCase };
