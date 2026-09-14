import { inject, injectable } from "tsyringe";
import { BusinessModule } from "@prisma/client";

import { IUserRepository } from "../../repositories/IUser-repository";

import { User } from "../../dtos/user-dto";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UploadService } from "@/shared/services/upload-service";

@injectable()
class GetUserUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(userId: string): Promise<User> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    return {
      ...findUser,
      enabledModules: resolveEnabledModules(findUser),
      avatar: findUser.avatar
        ? await this.uploadService.getFileUrl(findUser.avatar)
        : null,
    };
  }
}

/**
 * What this session may reach, module-wise. It travels with /me on purpose:
 * every user needs to know its own company's plan to draw a menu, while the
 * back-office endpoint that manages plans stays restricted to MASTER and
 * BUSINESS_ADMIN. Reading your own plan is not administering it.
 *
 * MASTER gets the whole enum — the back office operates across companies and
 * is never gated by what one of them hired.
 */
function resolveEnabledModules(user: User): string[] {
  if (user.role === "MASTER") {
    return Object.values(BusinessModule);
  }

  return (user.business?.entitlements ?? [])
    .filter((row) => row.enabled)
    .map((row) => row.module);
}

export { GetUserUseCase };
