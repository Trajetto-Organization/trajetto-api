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

import database from "@/../infra/database";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

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

    // Not only the request hook: a profile is what grants access in a
    // company, so its tenant is checked where it is written.
    assertTenantAccess(findUser, businessId);

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

    let profileAccessCreated: ProfileAccess;

    try {
      // The profile and its audit entry commit together (OUTBOX-10).
      profileAccessCreated = await database.$transaction(async (tx) => {
        const created = await this.profileAccess.createProfileAccess(
          { name, businessId },
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Perfil de acesso",
            action: "create",
            entityId: created.id,
            description: `Perfil de acesso criado com sucesso: ${created.name} | ID: ${created.id}`,
            status: "Completo",
            performedBy: userId,
            businessId: businessId,
          },
          tx,
        );

        return created;
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o perfil de acesso! Por favor, tente novamente.",
        500,
      );
    }

    // After the commit: pickers open in other tabs refetch (decision 2.3).
    sendCatalogChangedEvent(businessId, "profile_access");

    return profileAccessCreated;
  }
}

export { CreateProfileAccessUseCase };
