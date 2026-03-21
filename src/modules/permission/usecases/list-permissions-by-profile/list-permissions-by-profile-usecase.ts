import { inject, injectable } from "tsyringe";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { Permission } from "../../dtos/permission-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListPermissionsByProfileUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PermissionRepository")
    private permission: IPermissionRepository,
  ) {}

  async execute(
    profileAccessId: string,
    businessId: string,
    userId: string,
  ): Promise<Permission[]> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.permission.findPermissionsByProfile(
        profileAccessId,
        businessId,
      );

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de permissões por perfil!",
        500,
      );
    }
  }
}

export { ListPermissionsByProfileUseCase };
