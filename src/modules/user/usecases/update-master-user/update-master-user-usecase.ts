import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { UpdateMasterUserProps, User } from "../../dtos/user-dto";

import database from "@/../infra/database";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserCannotUpdateMasterUserError } from "../errors/user-cannot-update-master-user-error";

import { UserIsNotMasterError } from "../errors/user-is-not-master-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";
import { sendSecurityEventToUser } from "@/websocket";

import { env } from "@/env";

import {
  ADMIN_RESET_LINK_TTL_MS,
  PasswordLinkUnavailableError,
  issuePasswordSetupLink,
} from "../../services/password-setup-link";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";

const log = logger.child({ component: "user" });

interface UpdateMasterUserExecuteProps {
  masterUserId: string;
  data: UpdateMasterUserProps;
  performedById: string;
}

interface ChangeSummary {
  /** Formatted for in-app notifications: "name: X → Y, e-mail: A → B, password" */
  notificationText: string;
  /** Formatted for activity log: same as notificationText */
  activityText: string;
  passwordLinkSent: boolean;
}

@injectable()
class UpdateMasterUserUseCase {
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  private buildChangeSummary(
    before: User,
    after: User,
    passwordLinkSent: boolean,
  ): ChangeSummary {
    const parts: string[] = [];

    if (before.name !== after.name) {
      parts.push(`nome: ${before.name} → ${after.name}`);
    }

    if (before.email !== after.email) {
      parts.push(`e-mail: ${before.email} → ${after.email}`);
    }

    if (passwordLinkSent) {
      parts.push("link de redefinição de senha enviado");
    }

    const text = parts.join(", ");
    return { notificationText: text, activityText: text, passwordLinkSent };
  }

  private buildWhatsAppText({
    masterName,
    changesText,
    performingUserName,
    performingUserEmail,
  }: {
    masterName: string;
    changesText: string;
    performingUserName: string;
    performingUserEmail: string;
  }): string {
    return [
      `✏️ *Usuário Master Atualizado!*`,
      `Usuário: *${masterName}*`,
      `Campos alterados: *${changesText}*`,
      `Atualizado por: *${performingUserName}* (${performingUserEmail})`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  /**
   * The update e-mail. It never carries a password (decision 4.9); a reset
   * travels as a single-use link, in its own e-mail.
   */
  private async sendUpdateEmail(
    before: User,
    updatedMaster: User,
    changes: ChangeSummary,
    performingUserName: string,
    performingUserEmail: string,
  ): Promise<void> {
    try {
      await sendTransactionalMail({
        email: updatedMaster.email,
        name: updatedMaster.name,
        subject: "Sua conta Master foi atualizada",
        templateName: "master-user-updated.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          performingUserName,
          performingUserEmail,
          changesText: changes.notificationText,
          hasFieldChanges:
            before.name !== updatedMaster.name ||
            before.email !== updatedMaster.email,
          ...(before.name !== updatedMaster.name && {
            oldName: before.name,
            newName: updatedMaster.name,
          }),
          ...(before.email !== updatedMaster.email && {
            oldEmail: before.email,
            newEmail: updatedMaster.email,
          }),
          logo: emailLogoUrl(),
        },
      });
    } catch (error) {
      log.error(
        { err: error, userId: updatedMaster.id },
        "master user update e-mail could not be sent",
      );
    }
  }

  /**
   * Stores the single-use link BEFORE anything commits: when it cannot be
   * stored the request fails whole and changes nothing, instead of telling
   * the master a link went out that never existed (SEC-MAIL-1).
   */
  private async issuePasswordLink(
    email: string,
    userId: string,
  ): Promise<string> {
    try {
      return await issuePasswordSetupLink(
        this.usersTokens,
        email,
        ADMIN_RESET_LINK_TTL_MS,
      );
    } catch (error) {
      log.error(
        { err: error, userId },
        "password setup link could not be stored",
      );

      throw new PasswordLinkUnavailableError();
    }
  }

  /** Mailed after the commit. Out of the outbox: it carries a reset secret. */
  private sendPasswordLink(
    url: string,
    master: User,
    performingUserName: string,
  ): void {
    void sendTransactionalMail({
      email: master.email,
      name: master.name,
      subject: "Redefinição de senha",
      templateName: "password-reset-by-admin.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        url,
        performingUserName,
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      log.error(
        { err: error, userId: master.id },
        "password setup link e-mail could not be sent",
      ),
    );
  }

  async execute({
    masterUserId,
    data,
    performedById,
  }: UpdateMasterUserExecuteProps): Promise<User> {
    // Validate the performing user exists and is MASTER
    const performingUser = await this.user.findUserById(performedById);

    if (!performingUser) {
      throw new ResourceNotFoundError();
    }

    if (performingUser.role !== "MASTER") {
      throw new UserCannotUpdateMasterUserError();
    }

    // Cannot update yourself
    if (performedById === masterUserId) {
      throw new UserCannotBeUpdatedByHimselfError();
    }

    // Find the master user to be updated — snapshot before changes
    const masterUser = await this.user.findUserById(masterUserId);

    if (!masterUser) {
      throw new ResourceNotFoundError();
    }

    if (masterUser.role !== "MASTER") {
      throw new UserIsNotMasterError();
    }

    // Values, not presence: a field sent unchanged is not a change.
    const nameChanged = !!data.name && data.name !== masterUser.name;
    const emailChanged = !!data.email && data.email !== masterUser.email;
    const sendLink = data.sendPasswordSetupLink === true;

    if (emailChanged) {
      const emailExists = await this.user.findUserByEmail(data.email as string);

      if (emailExists && emailExists.id !== masterUser.id) {
        throw new UserAlreadyExistsError();
      }
    }

    if (!nameChanged && !emailChanged && !sendLink) {
      return masterUser;
    }

    const resetUrl = sendLink
      ? await this.issuePasswordLink(
          emailChanged ? (data.email as string) : masterUser.email,
          masterUserId,
        )
      : null;

    const updateData = {
      ...(nameChanged && { name: data.name as string }),
      ...(emailChanged && { email: data.email as string }),
    };

    try {
      // Two audiences, two events: the performer hears "you updated X", the
      // updated master hears "your account changed" (self-update is blocked
      // above, so both always apply). Both commit with the row itself.
      const updatedMaster = await database.$transaction(async (tx) => {
        const updated =
          nameChanged || emailChanged
            ? await this.user.updateUser(
                { userId: masterUserId, userData: updateData },
                tx,
              )
            : masterUser;

        const changes = this.buildChangeSummary(masterUser, updated, sendLink);

        await this.outbox.publish(tx, {
          topic: "master-user.updated",
          aggregateType: "master-user",
          aggregateId: updated.id,
          actorId: performedById,
          payload: {
            masterUserId: updated.id,
            masterName: updated.name,
            beforeName: masterUser.name,
            changesNotificationText: changes.notificationText,
            changesActivityText: changes.activityText,
            actorUserId: performedById,
            performingUserName: performingUser.name,
            performingUserEmail: performingUser.email,
          },
        });

        await this.outbox.publish(tx, {
          topic: "master-user.account-updated",
          aggregateType: "master-user",
          aggregateId: updated.id,
          actorId: performedById,
          payload: {
            masterUserId: updated.id,
            masterName: updated.name,
            changesNotificationText: changes.notificationText,
            performingUserName: performingUser.name,
            performingUserEmail: performingUser.email,
          },
        });

        return updated;
      });

      const changes = this.buildChangeSummary(
        masterUser,
        updatedMaster,
        sendLink,
      );

      // The session stays valid through a new e-mail; the client re-reads
      // /user/me to show it. Nobody is logged out for a rename.
      if (emailChanged) {
        sendSecurityEventToUser(masterUserId, {
          reason: "permissions_changed",
        });
      }

      if (nameChanged || emailChanged) {
        void this.sendUpdateEmail(
          masterUser,
          updatedMaster,
          changes,
          performingUser.name,
          performingUser.email,
        );
      }

      if (resetUrl) {
        this.sendPasswordLink(resetUrl, updatedMaster, performingUser.name);
      }

      return updatedMaster;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o usuário Master! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateMasterUserUseCase };
