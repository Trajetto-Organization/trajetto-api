import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { Permission } from "../../dtos/permission-dto";

import { NotificationService } from "@/shared/services/notification-service";
import { IPermissionRepository } from "../../repositories/IPermission-repository";

import { PermissionCannotBeDeletedByHimselfError } from "../errors/permission-cannot-be-deleted-by-himself-error";
import { PermissionNotFoundError } from "../errors/permission-not-found-error";

import { sendSecurityEventToBusiness } from "@/websocket";

import database from "@/../infra/database";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

@injectable()
class DeletePermissionUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PermissionRepository")
    private permission: IPermissionRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(permissionId: string, userId: string): Promise<Permission> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (
      findUser.profileAccess?.permissions.some(
        (permission) => permission.id === permissionId,
      )
    ) {
      throw new PermissionCannotBeDeletedByHimselfError();
    }

    const existingPermission =
      await this.permission.findPermissionById(permissionId);

    if (!existingPermission) {
      throw new PermissionNotFoundError();
    }

    assertTenantAccessToRecord(
      findUser,
      existingPermission.businessId,
      () => new PermissionNotFoundError(),
    );

    try {
      // The revocation and its audit entry commit together (OUTBOX-10).
      const permissionDeleted = await database.$transaction(async (tx) => {
        const deleted = await this.permission.deletePermission(
          permissionId,
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Permissão",
            action: "delete",
            entityId: deleted.id,
            description: `Permissão excluída: ${deleted.action} | ID: ${deleted.id}`,
            status: "Deletado",
            performedBy: userId,
            businessId: deleted.businessId,
          },
          tx,
        );

        return deleted;
      });

      sendSecurityEventToBusiness(permissionDeleted.businessId, {
        reason: "permissions_changed",
      });

      return permissionDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a permissão! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeletePermissionUseCase };
