import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToUser } from "@/websocket";

import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { UserHasAssociatedServiceOrdersError } from "../errors/user-has-associated-service-orders-error";
import { UserHasAssociatedAccountPayablesError } from "../errors/user-has-associated-account-payables-error";
import { UserHasRecordsError } from "../errors/user-has-records-error";

import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";
import { User, UserRole } from "../../dtos/user-dto";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";

import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

interface DeleteUserProps {
  userId: string;
  id: string;
}

@injectable()
class DeleteUserUseCase {
  private allowedDeletion: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    // Masters leave only through delete-master-user, which counts and deletes
    // in one statement so the platform never ends with zero masters.
    MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN"],
  };

  private roleDisplayName: Record<UserRole, string> = {
    BUSINESS_USER: "Usuário",
    BUSINESS_ADMIN: "Administrador",
    MASTER: "Master",
  };

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({ userId, id }: DeleteUserProps): Promise<User> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.id === userId) {
      throw new UserCannotBeDeletedByHimselfError();
    }

    const findDeletedUser = await this.user.findUserById(userId);

    if (!findDeletedUser) {
      throw new ResourceNotFoundError();
    }

    // The route carries no :businessId, so nothing before this point has
    // compared the target's tenant with the caller's. Same shape as
    // user-revoke-access, which already does it.
    assertTenantAccessToRecord(
      findUser,
      findDeletedUser.businessId,
      () => new ResourceNotFoundError(),
    );

    // Two masters deleting each other here at once could leave none:
    // only delete-master-user keeps the last one.
    if (findDeletedUser.role === "MASTER") {
      throw permissionDenied(
        "Usuários Master são removidos na área de usuários Master.",
      );
    }

    // A role above the actor's is a permission refusal (decision 4.1): it
    // left with the generic code and the web could not say "sem permissão".
    if (!this.allowedDeletion[findUser.role].includes(findDeletedUser.role)) {
      throw permissionDenied(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem deletar usuários com o nível de acesso ${
          this.roleDisplayName[findDeletedUser.role]
        }.`,
      );
    }

    const associatedServiceOrders =
      await this.serviceOrder.findServiceOrdersByResponsibleUserId(userId);

    if (associatedServiceOrders.length > 0) {
      throw new UserHasAssociatedServiceOrdersError(
        associatedServiceOrders.length,
      );
    }

    const associatedAccountPayables =
      await this.accountPayable.findAccountPayablesByRegistrationUserId(userId);

    if (associatedAccountPayables.length > 0) {
      throw new UserHasAssociatedAccountPayablesError(
        associatedAccountPayables.length,
      );
    }

    try {
      // The deletion and its audit entry commit together (OUTBOX-10).
      const userDeleted = await database.$transaction(async (tx) => {
        const deleted = await this.user.deleteUser(userId, tx);

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Usuário",
            action: "delete",
            entityId: deleted.id,
            description: `Usuário ${deleted.name} | ${deleted.email} deletado | ID: ${deleted.id}`,
            status: "Deletado",
            performedBy: id,
            businessId: deleted.businessId as string,
          },
          tx,
        );

        return deleted;
      });

      sendSecurityEventToUser(userId, { reason: "access_denied" });

      // A driver lost its app login: the "com o app" split changed.
      if (userDeleted.driverId)
        announceDriverLoginChange(userDeleted.businessId);

      return userDeleted;
    } catch (error) {
      // A RESTRICT foreign key (an event, an import, a review, a message the
      // user authored) refused the delete: a conflict the operator can act
      // on, not a failure to retry.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2003"
      ) {
        throw new UserHasRecordsError();
      }

      throw new AppError(
        "Houve um erro ao tentar deletar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteUserUseCase };
