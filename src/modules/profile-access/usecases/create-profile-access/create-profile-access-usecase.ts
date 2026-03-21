import { inject, injectable } from "tsyringe";
import { AppError } from "@/shared/errors/AppError";

import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import {
  CreateProfileAccessProps,
  ProfileAccess,
} from "../../dtos/profile-access-dto";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccessAlreadyExistsError } from "../errors/profile-access-already-exists-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

@injectable()
class CreateProfileAccessUseCase {
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
    { name, businessId }: CreateProfileAccessProps,
    userId: string,
  ): Promise<ProfileAccess> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const existingProfile =
      await this.profileAccess.findProfileAccessByNameAndBusiness({
        name,
        businessId,
      });

    if (existingProfile) {
      throw new ProfileAccessAlreadyExistsError();
    }

    try {
      const profileAccessCreated = await this.profileAccess.createProfileAccess(
        {
          name,
          businessId,
        },
      );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Perfil de acesso",
        action: "create",
        entityId: profileAccessCreated.id,
        description: `Perfil de acesso criado com sucesso: ${profileAccessCreated.name} | ID: ${profileAccessCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: businessId,
      });

      return profileAccessCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateProfileAccessUseCase };
