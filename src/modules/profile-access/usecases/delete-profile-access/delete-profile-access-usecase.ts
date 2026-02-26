import { inject, injectable } from "tsyringe";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccess } from "../../dtos/profile-access-dto";
import { AppError } from "@/shared/errors/AppError";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ProfileAccessCannotBeDeletedByHimselfError } from "../errors/profile-access-cannot-be-deleted-by-himself-error";

import { sendSecurityEventToBusiness } from "@/websocket";

@injectable()
class DeleteProfileAccessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    profileAccessId: string,
    userId: string,
  ): Promise<ProfileAccess> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingProfileAccess =
      await this.profileAccess.findProfileAccessById(profileAccessId);

    if (!existingProfileAccess) {
      throw new ProfileAccessNotFoundError();
    }

    if (findUser.profileAccessId === profileAccessId) {
      throw new ProfileAccessCannotBeDeletedByHimselfError();
    }

    try {
      const profileAccessDeleted =
        await this.profileAccess.deleteProfileAccess(profileAccessId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Perfil de acesso",
        action: "delete",
        entityId: profileAccessDeleted.id,
        description: `Perfil de acesso excluído: ${profileAccessDeleted.name} | ID: ${profileAccessDeleted.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: profileAccessDeleted.businessId as string,
      });

      sendSecurityEventToBusiness(profileAccessDeleted.businessId as string, {
        reason: "permissions_changed",
      });

      return profileAccessDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteProfileAccessUseCase };
