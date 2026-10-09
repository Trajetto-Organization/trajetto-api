import { inject, injectable } from "tsyringe";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccess } from "../../dtos/profile-access-dto";
import { AppError } from "@/shared/errors/AppError";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ProfileAccessCannotBeDeletedByHimselfError } from "../errors/profile-access-cannot-be-deleted-by-himself-error";

import { sendCatalogChangedEvent, sendSecurityEventToBusiness } from "@/websocket";
import { ProfileAccessInUseError } from "../errors/profile-access-in-use-error";

import database from "@/../infra/database";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

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

    assertTenantAccessToRecord(
      findUser,
      existingProfileAccess.businessId,
      () => new ProfileAccessNotFoundError(),
    );

    if (findUser.profileAccessId === profileAccessId) {
      throw new ProfileAccessCannotBeDeletedByHimselfError();
    }

    // Deleting a profile in use left its people with no profile at all: they
    // could no longer log in (AUTH_PROFILE_NOT_CONFIGURED) and nobody was
    // told why. Refused with the count, as the other catalogs do (8.3).
    const usersCount = await this.user.countUsersWithProfile(profileAccessId);

    if (usersCount > 0) {
      throw new ProfileAccessInUseError(usersCount);
    }

    let profileAccessDeleted: ProfileAccess;

    try {
      // The deletion and its audit entry commit together (OUTBOX-10).
      profileAccessDeleted = await database.$transaction(async (tx) => {
        const deleted = await this.profileAccess.deleteProfileAccess(
          profileAccessId,
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Perfil de acesso",
            action: "delete",
            entityId: deleted.id,
            description: `Perfil de acesso excluído: ${deleted.name} | ID: ${deleted.id}`,
            status: "Deletado",
            performedBy: userId,
            businessId: deleted.businessId as string,
          },
          tx,
        );

        return deleted;
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }

    // After the commit and outside it: a hint that fails to leave must not
    // turn a deletion that happened into a 500.
    sendSecurityEventToBusiness(profileAccessDeleted.businessId as string, {
      reason: "permissions_changed",
    });

    sendCatalogChangedEvent(
      profileAccessDeleted.businessId as string,
      "profile_access",
    );

    return profileAccessDeleted;
  }
}

export { DeleteProfileAccessUseCase };
