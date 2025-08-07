import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ProfileAccess } from "../../dtos/profile-access-dto";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListProfileAccessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<{ data: ProfileAccess[]; total: number }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.profileAccess.listProfileAccess({
        page,
        pageSize,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        profileAccessId: findUser.profileAccessId as string,
        search,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de perfis de acesso!",
        500,
      );
    }
  }
}

export { ListProfileAccessUseCase };
