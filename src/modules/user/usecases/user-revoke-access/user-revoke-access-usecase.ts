import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { ToggleConflictError } from "@/modules/business/usecases/errors/toggle-conflict-error";

import { UserRole } from "../../dtos/user-dto";
import { UserCannotBeRevokeByHimselfError } from "../errors/user-cannot-be-revoke-access-by-himself-error";

import { sendSecurityEventToUser } from "@/websocket";
import { permissionDenied } from "@/shared/errors/access-errors";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";
import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import type { IDriverEnrollmentRepository } from "../../repositories/IDriver-enrollment-repository";
import { totalOpenRoutes } from "@/modules/driver/driver-rules";
import { DriverHasOpenRoutesError } from "@/modules/driver/usecases/errors/driver-has-open-routes-error";
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
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DriverEnrollmentRepository")
    private driverEnrollment: IDriverEnrollmentRepository,
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

    // A driver's revoked login strands a route that still needs them, as
    // deactivating the driver would (K10, decision D31): refused with the
    // same counts. Only revoking: giving the login back is what lets such a
    // route run. Read before the flip, like the driver deactivation's count
    // used to be; a route released in the instant between is the same rare
    // window it was there, and the dispatcher sees the driver locked out.
    if (!wasRevoked && findRevokedUser.driverId) {
      const openRoutes = await this.driver.countOpenRoutes(
        findRevokedUser.driverId,
      );

      if (totalOpenRoutes(openRoutes) > 0) {
        throw new DriverHasOpenRoutesError(openRoutes, "REVOKE_ACCESS");
      }
    }

    const flipped = await this.user.toggleUserAccessRevocation(
      userId,
      wasRevoked,
    );

    if (!flipped) {
      throw new ToggleConflictError("de acesso deste usuário");
    }

    // The access QR code still on a screen dies with the access (plan of
    // 02/11/2026, D3/D5). Revoked, it could not be consumed anyway; but a
    // restore within its ten minutes brought it back, and a screenshot that
    // went to the wrong person is a common reason to revoke in the first
    // place. Restoring issues nothing: the manager shows a new code.
    if (!wasRevoked && findRevokedUser.driverId) {
      await this.driverEnrollment.revokeForUser(userId);
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
