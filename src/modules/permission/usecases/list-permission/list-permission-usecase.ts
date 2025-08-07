import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { Permission } from "../../dtos/permission-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListPermissionUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PermissionRepository")
    private permission: IPermissionRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<{ data: Permission[]; total: number }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.permission.listPermission({
        page,
        pageSize,
        search,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        profileAccessId: findUser.profileAccessId as string,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de permissões!",
        500,
      );
    }
  }
}

export { ListPermissionUseCase };
