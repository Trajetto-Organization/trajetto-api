import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToUser } from "@/websocket";

import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";
import { UserHasRecordsError } from "../errors/user-has-records-error";

import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { totalOpenRoutes } from "@/modules/driver/driver-rules";
import { DriverHasOpenRoutesError } from "@/modules/driver/usecases/errors/driver-has-open-routes-error";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";
import { isForeignKeyViolation } from "@/shared/errors/prisma-error-meta";
import { User, UserRole } from "../../dtos/user-dto";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";
import { userHistoryRefusal } from "../../user-history-rules";

import database from "@/../infra/database";

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
    @inject("DriverRepository")
    private driver: IDriverRepository,
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

    // A driver's login whose route still needs it: deleted, the route would
    // wait for someone who can no longer sign in, and the phone's outbox
    // stalls on "auth" (the revocation's rule, K10). Starting a route writes
    // no row that names the login, so no foreign key held this back. Read
    // before the delete, like the revocation's count.
    if (findDeletedUser.driverId) {
      const openRoutes = await this.driver.countOpenRoutes(
        findDeletedUser.driverId,
      );

      if (totalOpenRoutes(openRoutes) > 0) {
        throw new DriverHasOpenRoutesError(openRoutes, "DELETE_LOGIN");
      }
    }

    // Deleting is for a login made by mistake; whoever worked keeps the
    // history and has the access revoked (docs/arquitetura.md, "Excluir x
    // inativar/revogar"). One count for every RESTRICT key, so the answer
    // names what holds the login instead of a generic "por exemplo".
    const refusal = userHistoryRefusal(
      await this.user.countUserHistory(userId),
    );

    if (refusal) throw refusal;

    try {
      // The deletion and its audit entry commit together (OUTBOX-10).
      const userDeleted = await database.$transaction(async (tx) => {
        const deleted = await this.user.deleteUser(userId, tx);

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Usuário",
            action: "delete",
            entityId: deleted.id,
            // A driver's login may have no e-mail (plan of 02/11/2026, D2).
            description: deleted.email
              ? `Usuário ${deleted.name} | ${deleted.email} deletado | ID: ${deleted.id}`
              : `Usuário ${deleted.name} (sem e-mail) deletado | ID: ${deleted.id}`,
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
      // A row committed between the count and the delete met its RESTRICT
      // key: counted again, it gets the answer the count would have given. A
      // key the count does not know keeps the generic sentence.
      if (isForeignKeyViolation(error)) {
        throw (
          userHistoryRefusal(await this.user.countUserHistory(userId)) ??
          new UserHasRecordsError()
        );
      }

      throw new AppError(
        "Houve um erro ao tentar deletar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteUserUseCase };
