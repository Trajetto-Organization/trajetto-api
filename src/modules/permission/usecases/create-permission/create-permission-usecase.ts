import { inject, injectable } from "tsyringe";
import { IPermissionRepository } from "../../repositories/IPermission-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { CreatePermissionProps, Permission } from "../../dtos/permission-dto";

import { PermissionAlreadyExistsError } from "../errors/permission-already-exists-error";
import { PermissionAlreadyAssignedError } from "../errors/permission-already-assigned-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { PermissionBusinessError } from "../errors/permission-business-error";
import { AppError } from "@/shared/errors/AppError";

import { sendSecurityEventToBusiness } from "@/websocket";

@injectable()
class CreatePermissionUseCase {
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
    {
      action,
      businessId,
      canRead,
      canWrite,
      profileAccessId,
      permissionKey,
    }: CreatePermissionProps,
    userId: string,
  ): Promise<Permission> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const findProfileAccessById =
      await this.profileAccess.findProfileAccessById(profileAccessId);

    if (!findProfileAccessById) {
      throw new UserProfileAccessNotFoundError();
    }

    if (findProfileAccessById.businessId !== businessId) {
      throw new PermissionBusinessError();
    }

    const existingPermission =
      await this.permission.findPermissionNameByProfile({
        action,
        businessId,
        profileAccessId,
      });

    if (existingPermission) {
      throw new PermissionAlreadyExistsError();
    }

    const existingPermissionKey =
      await this.permission.findPermissionKeyByProfile({
        permissionKey,
        profileAccessId,
        businessId,
      });

    if (existingPermissionKey) {
      throw new PermissionAlreadyAssignedError();
    }

    try {
      const permissionCreated = await this.permission.createPermission({
        action,
        businessId,
        canRead,
        canWrite,
        profileAccessId,
        permissionKey,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Permissão",
        action: "create",
        entityId: permissionCreated.id,
        description: `Permissão criada com sucesso: ${permissionCreated.action} | Chave: ${permissionCreated.permissionKey} | Leitura: ${permissionCreated.canRead ? "Sim" : "Não"} | Escrita: ${permissionCreated.canWrite ? "Sim" : "Não"} | ID: ${permissionCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: businessId,
      });

      sendSecurityEventToBusiness(businessId, {
        reason: "permissions_changed",
      });

      return permissionCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a permissão! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreatePermissionUseCase };
