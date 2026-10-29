import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { ToggleConflictError } from "@/modules/business/usecases/errors/toggle-conflict-error";

import { UserRole } from "../../dtos/user-dto";
import { UserCannotBeRevokeByHimselfError } from "../errors/user-cannot-be-revoke-access-by-himself-error";

import { sendSecurityEventToUser } from "@/websocket";
import { permissionDenied } from "@/shared/errors/access-errors";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

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

    // Another company's user (or a MASTER) answers like a missing id.
    assertTenantAccessToRecord(
      findUser,
      findRevokedUser.businessId,
      () => new ResourceNotFoundError(),
    );

    // A role above the actor's is a permission refusal (decision 4.1), and
    // this act is revoking, not deleting.
    if (!this.allowedDeletion[findUser.role].includes(findRevokedUser.role)) {
      throw permissionDenied(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem revogar ou restaurar o acesso de usuários com o nível de acesso ${
          this.roleDisplayName[findRevokedUser.role]
        }.`,
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

    // A driver's app login went dark (or came back): the "com o app" split
    // of the company's chat pickers changed.
    if (findRevokedUser.driverId) {
      announceDriverLoginChange(findRevokedUser.businessId);
    }
  }
}

export { UserRevokeAccessUseCase };
