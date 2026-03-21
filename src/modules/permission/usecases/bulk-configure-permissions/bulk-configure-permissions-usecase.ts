import { inject, injectable } from "tsyringe";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { BulkConfigurePermissionsProps } from "../../dtos/permission-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";
import { PermissionBusinessError } from "../errors/permission-business-error";

import { AppError } from "@/shared/errors/AppError";
import { sendSecurityEventToBusiness } from "@/websocket";

@injectable()
class BulkConfigurePermissionsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PermissionRepository")
    private permission: IPermissionRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    props: BulkConfigurePermissionsProps,
    userId: string,
  ): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(props.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findProfile = await this.profileAccess.findProfileAccessById(
      props.profileAccessId,
    );

    if (!findProfile) {
      throw new UserProfileAccessNotFoundError();
    }

    if (findProfile.businessId !== props.businessId) {
      throw new PermissionBusinessError();
    }

    try {
      await this.permission.bulkConfigurePermissions(props);
      this.notificationService.createActivityIfEnabled({
        type: "Permissão",
        action: "update",
        entityId: props.profileAccessId,
        description: `Permissões configuradas em lote para o perfil: ${findProfile.name} | Total: ${props.permissions.length} permissão(ões) configurada(s)`,
        status: "Atualizado",
        performedBy: userId,
        businessId: props.businessId,
      });

      sendSecurityEventToBusiness(props.businessId, {
        reason: "permissions_changed",
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao configurar as permissões! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { BulkConfigurePermissionsUseCase };
