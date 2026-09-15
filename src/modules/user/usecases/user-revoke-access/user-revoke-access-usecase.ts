import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import { ToggleConflictError } from "@/modules/business/usecases/errors/toggle-conflict-error";

import { UserRole } from "../../dtos/user-dto";
import { UserCannotBeRevokeByHimselfError } from "../errors/user-cannot-be-revoke-access-by-himself-error";

import { sendSecurityEventToUser } from "@/websocket";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface UserRevokeAccessProps {
  userId: string;
  id: string;
}

@injectable()
class UserRevokeAccessUseCase {
  private allowedDeletion: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN", "MASTER"],
  };

  private roleDisplayName: Record<UserRole, string> = {
    BUSINESS_USER: "Usuário",
    BUSINESS_ADMIN: "Administrador",
    MASTER: "Master",
  };

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({ userId, id }: UserRevokeAccessProps): Promise<void> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.id === userId) {
      throw new UserCannotBeRevokeByHimselfError();
    }

    const findRevokedUser = await this.user.findUserById(userId);

    if (!findRevokedUser) {
      throw new ResourceNotFoundError();
    }

    if (!findRevokedUser.businessId && findUser.role !== "MASTER") {
      throw new AppError(
        "Acesso negado ao usuario informado.",
        403,
        "TENANT_ACCESS_DENIED",
      );
    }

    if (findRevokedUser.businessId) {
      assertTenantAccess(findUser, findRevokedUser.businessId);
    }

    if (!this.allowedDeletion[findUser.role].includes(findRevokedUser.role)) {
      throw new AppError(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem deletar usuários com o nível de acesso ${
          this.roleDisplayName[findRevokedUser.role]
        }.`,
        403,
        "USER_ROLE_ACTION_FORBIDDEN",
      );
    }

    /**
     * The state that was read is the precondition, and the event follows the
     * write rather than the intention.
     *
     * Two administrators acting on the same account at once — one revoking,
     * one restoring — both read the old value and both wrote. The row ended up
     * with whichever query landed last, while BOTH pushed a security event
     * down the socket: the user could be told "your access was restored" and
     * remain locked out, or be kicked out of a session that was never revoked.
     * Now the second one writes nothing, sends nothing, and is told why.
     */
    const wasRevoked = findRevokedUser.access_revoked ?? false;

    const flipped = await this.user.toggleUserAccessRevocation(
      userId,
      wasRevoked,
    );

    if (!flipped) {
      throw new ToggleConflictError("de acesso deste usuário");
    }

    sendSecurityEventToUser(userId, {
      reason: wasRevoked ? "access_restored" : "access_revoked",
    });
  }
}

export { UserRevokeAccessUseCase };
