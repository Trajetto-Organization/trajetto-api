import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { UserDriverAlreadyLinkedToUserError } from "../errors/user-driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";
import { UserAssignmentRequiredError } from "../errors/user-assignment-required-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";

import { UserProfileAccessNotFoundError } from "../errors/user-profile-access-not-found-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UpdateUser, User, UserRole } from "../../dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { UserMasterOnlyCanBeUpdatePasswordError } from "../errors/user-master-only-can-be-update-password-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";
import { refreshDeliveryRooms, sendSecurityEventToUser } from "@/websocket";

import { env } from "@/env";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

import {
  ADMIN_RESET_LINK_TTL_MS,
  PasswordLinkUnavailableError,
  issuePasswordSetupLink,
} from "../../services/password-setup-link";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";

import { describeChanges, planUserUpdate } from "./user-update-plan";

import database from "@/../infra/database";

const log = logger.child({ component: "user" });

@injectable()
class UpdateUserUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  private allowedUpdate: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    // Masters are edited only through update-master-user, which keeps the
    // master rules (no company, the master outbox notices).
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
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  // The same refusal as a missing permission (decision 4.1).
  private refuseRole(actorRole: UserRole, role: UserRole): AppError {
    return permissionDenied(
      `Usuários com o nível de acesso "${
        this.roleDisplayName[actorRole]
      }" não podem atualizar usuários com o nível de acesso ${
        this.roleDisplayName[role]
      }.`,
    );
  }

  /**
   * `userId` is the person being edited, `id` the one editing (the names
   * predate this file and every caller passes them this way).
   */
  async execute({ userId, userData }: UpdateUser, id: string): Promise<User> {
    const actor = await this.user.findUserById(id);

    if (!actor) {
      throw new ResourceNotFoundError();
    }

    if (actor.id === userId) {
      throw new UserCannotBeUpdatedByHimselfError();
    }

    const target = await this.user.findUserById(userId);

    if (!target) {
      throw new ResourceNotFoundError();
    }

    // Against the target's CURRENT tenant, before any of the checks below.
    assertTenantAccessToRecord(actor, target.businessId, () => new ResourceNotFoundError());

    // A master is not a company user: this route would give them a company
    // and skip the master notices. update-master-user is their route.
    if (target.role === "MASTER") {
      throw permissionDenied(
        "Usuários Master são alterados na área de usuários Master.",
      );
    }

    if (userData.sendPasswordSetupLink && actor.role !== "MASTER") {
      throw new UserMasterOnlyCanBeUpdatePasswordError();
    }

    const plan = planUserUpdate(target, userData);

    if (!plan.ok) {
      throw plan.error === "both_profile_and_driver"
        ? new UserCannotHaveBothDriverAndProfileError()
        : new UserAssignmentRequiredError();
    }

    const { next, changes } = plan;

    // Both ends: a user may demote an administrator only if they may edit
    // administrators at all. Checking the new role alone let a BUSINESS_USER
    // with the write permission turn an administrator into a user.
    if (!this.allowedUpdate[actor.role].includes(target.role)) {
      throw this.refuseRole(actor.role, target.role);
    }

    if (!this.allowedUpdate[actor.role].includes(next.role)) {
      throw this.refuseRole(actor.role, next.role);
    }

    // The links are checked against the person's company, which no edit
    // changes (decision 16.100).
    if (next.profileAccessId && changes.profile) {
      const profile = await this.profileAccess.findProfileAccessById(
        next.profileAccessId,
      );

      if (!profile) {
        throw new UserProfileAccessNotFoundError();
      }

      if (profile.businessId !== next.businessId) {
        throw new UserProfileNotMatchBusinessError();
      }
    }

    if (next.driverId && changes.driver) {
      const driver = await this.driver.findDriverById(next.driverId);

      if (!driver) {
        throw new DriverNotFoundError();
      }

      if (driver.businessId !== next.businessId) {
        throw new DriverNotBelongBusinessError();
      }

      const linkedUser = await this.user.findUserByDriverId(next.driverId);

      if (linkedUser && linkedUser.id !== userId) {
        throw new UserDriverAlreadyLinkedToUserError();
      }
    }

    if (changes.email) {
      const sameEmail = await this.user.findUserByEmail(next.email);

      if (sameEmail && sameEmail.id !== target.id) {
        throw new UserAlreadyExistsError();
      }
    }

    const sendLink = userData.sendPasswordSetupLink === true;

    // Nothing differs and nothing was asked: no write, no audit entry, no
    // e-mail and, above all, nobody logged out.
    if (!plan.changed && !sendLink) {
      return target;
    }

    // The link is stored before anything commits: when it cannot be, the
    // request fails whole and changes nothing, instead of answering
    // success for a link that does not exist (SEC-MAIL-1).
    const resetUrl = sendLink
      ? await this.issueResetLink(next.email, userId)
      : null;

    let updated: User;

    try {
      // The change, the end of the sessions and the audit entry commit
      // together (OUTBOX-10, decision 4.6). The e-mails go after the commit,
      // never inside it: they are not undone by a rollback.
      updated = await database.$transaction(async (tx) => {
        const row = plan.changed
          ? await this.user.updateUser({ userId, userData: plan.data }, tx)
          : target;

        if (plan.endsSessions) {
          await this.user.endSessionsAndClearInbox(userId, tx);
        }

        const what = [
          plan.changed ? describeChanges(changes) : "",
          sendLink ? "link de redefinição de senha enviado" : "",
        ]
          .filter(Boolean)
          .join("; ");

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Usuário",
            action: "update",
            entityId: row.id,
            description: `Usuário ${row.name} | ID: ${row.id} atualizado (${what})`,
            status: "Atualizado",
            performedBy: id,
            businessId: next.businessId,
          },
          tx,
        );

        return row;
      });
    } catch (error) {
      log.error({ err: error, userId }, "user update could not be committed");

      throw new AppError(
        "Houve um erro ao tentar atualizar o usuário! Por favor, tente novamente.",
        500,
      );
    }

    this.announce(userId, next.businessId, plan);

    // A driver's app login moved (to another driver or to none): the driver
    // catalogue's "com o app" split changed.
    if (changes.driver) {
      announceDriverLoginChange(
        target.driverId ? target.businessId : null,
        next.driverId ? next.businessId : null,
      );
    }

    if (plan.changed) {
      void this.mailAccountUpdated(target, next.email, next.name, changes.email);
    }

    // The e-mail itself leaves after the answer, never inside the commit.
    if (resetUrl) {
      void this.mailPasswordSetupLink(resetUrl, next.email, next.name, actor.name, userId);
    }

    return updated;
  }

  private async issueResetLink(email: string, userId: string): Promise<string> {
    try {
      return await issuePasswordSetupLink(
        this.usersTokens,
        email,
        ADMIN_RESET_LINK_TTL_MS,
      );
    } catch (error) {
      log.error({ err: error, userId }, "password setup link could not be stored");

      throw new PasswordLinkUnavailableError();
    }
  }

  /**
   * Tells the person's open screens, after the commit.
   *
   * - role or driver changed: their sessions are already over in
   *   the database; `role_changed` closes the sockets and says why.
   * - profile or e-mail changed: the session stays valid, the client re-reads
   *   /user/me (menus, buttons, the header's e-mail), and the dispatch rooms
   *   are re-evaluated for the new profile.
   * - name only: nothing to tell.
   */
  private announce(
    userId: string,
    businessId: string | null,
    plan: Extract<ReturnType<typeof planUserUpdate>, { ok: true }>,
  ): void {
    if (plan.endsSessions) {
      sendSecurityEventToUser(userId, { reason: "role_changed" });
      return;
    }

    if (plan.changes.profile || plan.changes.email) {
      sendSecurityEventToUser(userId, { reason: "permissions_changed" });
    }

    if (plan.changes.profile && businessId) {
      void refreshDeliveryRooms(businessId).catch((error) =>
        log.error({ err: error, businessId }, "delivery rooms could not be re-evaluated"),
      );
    }
  }

  private async mailAccountUpdated(
    before: User,
    email: string,
    name: string,
    emailChanged: boolean,
  ): Promise<void> {
    // The old address hears about it too: it is the one that can say "that
    // was not me" when an account is being taken over.
    const recipients = emailChanged ? [email, before.email] : [email];

    await Promise.all(
      recipients.map((recipient) =>
        sendTransactionalMail({
          email: recipient,
          name,
          subject: "Conta atualizada com sucesso",
          templateName: "user-updated-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            logo: this.cloudinaryLogo,
          },
        }).catch((error) =>
          log.error(
            { err: error, userId: before.id },
            "account update e-mail could not be sent",
          ),
        ),
      ),
    );
  }

  /**
   * The link, never a password (decision 4.9). Kept out of the outbox: it
   * carries a reset secret, which must not sit in a persisted payload.
   */
  private async mailPasswordSetupLink(
    url: string,
    email: string,
    name: string,
    performingUserName: string,
    userId: string,
  ): Promise<void> {
    try {
      await sendTransactionalMail({
        email,
        name,
        subject: "Redefinição de senha",
        templateName: "password-reset-by-admin.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          url,
          performingUserName,
          logo: this.cloudinaryLogo,
        },
      });
    } catch (error) {
      log.error({ err: error, userId }, "password setup link could not be sent");
    }
  }
}

export { UpdateUserUseCase };
