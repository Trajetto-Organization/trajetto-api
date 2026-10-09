import { inject, injectable } from "tsyringe";
import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { PermissionKey } from "@/config/permissions";

import {
  Permission,
  UpdatePermission,
  UpdatePermissionInput,
} from "../../dtos/permission-dto";
import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";

import { PermissionAlreadyAssignedError } from "../errors/permission-already-assigned-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { PermissionNotFoundError } from "../errors/permission-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { PermissionAlreadyExistsError } from "../errors/permission-already-exists-error";

import { PermissionCannotBeUpdatedByHimselfError } from "../errors/permission-cannot-be-updated-by-himself-error";
import { PermissionBusinessError } from "../errors/permission-business-error";
import { assertNotOwnProfile } from "../errors/permission-own-profile-error";

import { sendSecurityEventToBusiness } from "@/websocket";

import database from "@/../infra/database";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

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

  /**
   * The company is not an input (decision 16.100): it is the permission's own,
   * read from the row. A body businessId used to be written back, so a
   * MASTER could move a permission onto another company's profile.
   */
  async execute(
    input: UpdatePermissionInput,
    userId: string,
  ): Promise<Permission> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (
      findUser.profileAccess?.permissions.some(
        (permission) => permission.id === input.permissionId,
      )
    ) {
      throw new PermissionCannotBeUpdatedByHimselfError();
    }

    const existingPermission = await this.permission.findPermissionById(
      input.permissionId,
    );

    if (!existingPermission) {
      throw new PermissionNotFoundError();
    }

    // The permission's tenant, which is also the only one it may end in.
    assertTenantAccessToRecord(findUser, existingPermission.businessId, () => new PermissionNotFoundError());

    // Spread first: a caller passing a businessId anyway cannot override it.
    const permissionData: UpdatePermission = {
      ...input,
      businessId: existingPermission.businessId,
    };

    // Neither end may be the actor's own profile: moving a permission INTO
    // it is a grant to yourself, as much as editing one already there.
    assertNotOwnProfile(findUser, existingPermission.profileAccessId);
    assertNotOwnProfile(findUser, permissionData.profileAccessId);

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
      // The change and its audit entry commit together (OUTBOX-10).
      const permissionUpdated = await database.$transaction(async (tx) => {
        const updated = await this.permission.updatePermission(
          permissionData,
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Permissão",
            action: "update",
            entityId: updated.id,
            description: `Permissão atualizada com sucesso: ${updated.action} | Leitura: ${updated.canRead ? "Sim" : "Não"} | Escrita: ${updated.canWrite ? "Sim" : "Não"} | ID: ${updated.id}`,
            status: "Atualizado",
            performedBy: userId,
            businessId: permissionData.businessId,
          },
          tx,
        );

        return updated;
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
