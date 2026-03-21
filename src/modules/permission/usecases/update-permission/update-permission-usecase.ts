import { inject, injectable } from "tsyringe";
import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { PermissionKey } from "@/config/permissions";

import { Permission, UpdatePermission } from "../../dtos/permission-dto";
import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";

import { PermissionAlreadyAssignedError } from "../errors/permission-already-assigned-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { PermissionNotFoundError } from "../errors/permission-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { PermissionAlreadyExistsError } from "../errors/permission-already-exists-error";

import { PermissionCannotBeUpdatedByHimselfError } from "../errors/permission-cannot-be-updated-by-himself-error";
import { PermissionBusinessError } from "../errors/permission-business-error";

import { sendSecurityEventToBusiness } from "@/websocket";

@injectable()
class UpdatePermissionUseCase {
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
    permissionData: UpdatePermission,
    userId: string,
  ): Promise<Permission> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (
      findUser.profileAccess?.permissions.some(
        (permission) => permission.id === permissionData.permissionId,
      )
    ) {
      throw new PermissionCannotBeUpdatedByHimselfError();
    }

    const existingPermission = await this.permission.findPermissionById(
      permissionData.permissionId,
    );

    if (!existingPermission) {
      throw new PermissionNotFoundError();
    }

    const permissionAlreadyExists =
      await this.permission.findPermissionNameByProfile({
        action: permissionData.action as string,
        businessId: permissionData.businessId,
        profileAccessId: permissionData.profileAccessId,
      });

    if (
      permissionAlreadyExists &&
      permissionAlreadyExists.id !== permissionData.permissionId
    ) {
      throw new PermissionAlreadyExistsError();
    }

    const existingProfileAccess =
      await this.profileAccess.findProfileAccessById(
        permissionData.profileAccessId,
      );

    if (!existingProfileAccess) {
      throw new ProfileAccessNotFoundError();
    }

    // Validation: The access profile must belong to the same company
    if (existingProfileAccess.businessId !== permissionData.businessId) {
      throw new PermissionBusinessError();
    }

    const existingBusinness = await this.business.findBusinessById(
      permissionData.businessId,
    );

    if (!existingBusinness) {
      throw new BusinessNotFoundError();
    }

    const existingPermissionKey =
      await this.permission.findPermissionKeyByProfile({
        permissionKey: permissionData.permissionKey as PermissionKey,
        profileAccessId: permissionData.profileAccessId,
        businessId: permissionData.businessId,
      });

    // Only throw error if the found permission is different from the one being updated
    if (
      existingPermissionKey &&
      existingPermissionKey.id !== permissionData.permissionId
    ) {
      throw new PermissionAlreadyAssignedError();
    }

    try {
      const permissionUpdated =
        await this.permission.updatePermission(permissionData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Permissão",
        action: "update",
        entityId: permissionUpdated.id,
        description: `Permissão atualizada com sucesso: ${permissionUpdated.action} | Leitura: ${permissionUpdated.canRead ? "Sim" : "Não"} | Escrita: ${permissionUpdated.canWrite ? "Sim" : "Não"} | ID: ${permissionUpdated.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: permissionData.businessId,
      });

      sendSecurityEventToBusiness(permissionData.businessId, {
        reason: "permissions_changed",
      });

      return permissionUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a permissão! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdatePermissionUseCase };
