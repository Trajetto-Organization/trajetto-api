import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPartRepository } from "@/modules/part/repositories/IPart-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListPartProps } from "../../dtos/part-dto";

@injectable()
class ListPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PartRepository")
    private part: IPartRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListPartProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const parts = await this.part.listParts({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return parts;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as peças! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListPartUseCase };
