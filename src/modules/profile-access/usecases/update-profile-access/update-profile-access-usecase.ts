import { inject, injectable } from "tsyringe";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import {
  ProfileAccess,
  UpdateProfileAccess,
} from "../../dtos/profile-access-dto";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ProfileAccessAlreadyExistsError } from "../errors/profile-access-already-exists-error";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccessCannotBeUpdatedByHimselfError } from "../errors/profile-access-cannot-be-updated-by-himself-error";
import { ProfileAccessBusinessLockedError } from "../errors/profile-access-business-locked-error";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

import database from "@/../infra/database";

@injectable()
class UpdateProfileAccessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    { profileAccessId, businessId, name }: UpdateProfileAccess,
    userId: string,
  ): Promise<ProfileAccess> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingProfile =
      await this.profileAccess.findProfileAccessById(profileAccessId);

    if (!existingProfile) {
      throw new ProfileAccessNotFoundError();
    }

    // The profile's CURRENT tenant, not the one in the body.
    assertTenantAccessToRecord(findUser, existingProfile.businessId, () => new ProfileAccessNotFoundError());

    // A profile stays in its company. Moving it used to carry its users
    // along without ending their sessions or clearing their inbox
    // (decision 4.6); a person changes company through their own record.
    if (businessId && businessId !== existingProfile.businessId) {
      throw new ProfileAccessBusinessLockedError();
    }

    if (findUser.profileAccessId === profileAccessId) {
      throw new ProfileAccessCannotBeUpdatedByHimselfError();
    }

    const profileBusinessId = existingProfile.businessId as string;

    const findBusinessById =
      await this.business.findBusinessById(profileBusinessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const targetName = name || existingProfile.name;

    // Nothing to write: no audit entry, no event.
    if (targetName === existingProfile.name) {
      return existingProfile;
    }

    const exists = await this.profileAccess.findProfileAccessByNameAndBusiness({
      name: targetName,
      businessId: profileBusinessId,
    });

    if (exists && exists.id !== profileAccessId) {
      throw new ProfileAccessAlreadyExistsError();
    }

    let updatedProfile: ProfileAccess;

    try {
      // The change and its audit entry commit together (OUTBOX-10).
      updatedProfile = await database.$transaction(async (tx) => {
        const updated = await this.profileAccess.updateProfileAccess(
          {
            profileAccessId,
            businessId: profileBusinessId,
            name: targetName,
          },
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Perfil de acesso",
            action: "update",
            entityId: updated.id,
            description: `Perfil de acesso atualizado com sucesso: ${updated.name} | ID: ${updated.id}`,
            status: "Atualizado",
            performedBy: userId,
            businessId: profileBusinessId,
          },
          tx,
        );

        return updated;
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }

    // After the commit: pickers open in other tabs refetch the new name
    // (decision 2.3).
    sendCatalogChangedEvent(profileBusinessId, "profile_access");

    return updatedProfile;
  }
}

export { UpdateProfileAccessUseCase };
