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
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccessCannotBeUpdatedByHimselfError } from "../errors/profile-access-cannot-be-updated-by-himself-error";
import { AppError } from "@/shared/errors/AppError";

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

    if (findUser.profileAccessId === profileAccessId) {
      throw new ProfileAccessCannotBeUpdatedByHimselfError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const isSameName = name === existingProfile.name;

    if (name && !isSameName) {
      const targetBusinessId = businessId || existingProfile.businessId;

      const exists =
        await this.profileAccess.findProfileAccessByNameAndBusiness({
          name,
          businessId: targetBusinessId as string,
        });

      if (exists && exists.id !== profileAccessId) {
        throw new ProfileAccessAlreadyExistsError();
      }
    }

    try {
      const updatedProfile = await this.profileAccess.updateProfileAccess({
        profileAccessId,
        businessId: businessId || (existingProfile.businessId as string),
        name: name || existingProfile.name,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Perfil de acesso",
        action: "update",
        entityId: updatedProfile.id,
        description: `Perfil de acesso atualizado com sucesso: ${updatedProfile.name} | ID: ${updatedProfile.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId || (existingProfile.businessId as string),
      });

      return updatedProfile;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateProfileAccessUseCase };
