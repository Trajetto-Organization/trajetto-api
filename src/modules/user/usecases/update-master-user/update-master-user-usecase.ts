import { hash } from "bcrypt";
import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
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
import { sendSecurityEventToUser } from "@/websocket";

import { env } from "@/env";

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
  passwordChanged: boolean;
}

@injectable()
class UpdateMasterUserUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  private buildChangeSummary(
    before: User,
    after: User,
    passwordChanged: boolean,
  ): ChangeSummary {
    const parts: string[] = [];

    if (before.name !== after.name) {
      parts.push(`nome: ${before.name} → ${after.name}`);
    }

    if (before.email !== after.email) {
      parts.push(`e-mail: ${before.email} → ${after.email}`);
    }

    // Never expose password value in notifications — just flag it changed
    if (passwordChanged) {
      parts.push("senha");
    }

    const text = parts.join(", ");
    return { notificationText: text, activityText: text, passwordChanged };
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
   * The update e-mail stays here rather than in the notification pipeline:
   * it may carry the new password in plain text, which must never sit in a
   * persisted outbox payload.
   */
  private async sendUpdateEmail(
    before: User,
    updatedMaster: User,
    changes: ChangeSummary,
    rawPassword: string | undefined,
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
          ...(changes.passwordChanged &&
            rawPassword && { newPassword: rawPassword }),
          logo: this.cloudinaryLogo,
        },
      });
    } catch (error) {
      console.error("[Usuário Master] Erro ao enviar e-mail:", error);
    }
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

    // Check if new email already exists (if changing email)
    if (data.email && data.email !== masterUser.email) {
      const emailExists = await this.user.findUserByEmail(data.email);

      if (emailExists) {
        throw new UserAlreadyExistsError();
      }
    }

    // Build update data
    const updateData: any = {};

    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;

    const rawPassword =
      data.password && data.password.trim() !== "" ? data.password : undefined;

    if (rawPassword) {
      updateData.password = await hash(rawPassword, 10);
    }

    try {
      // Two audiences, two events: the performer hears "you updated X", the
      // updated master hears "your account changed" (self-update is blocked
      // above, so both always apply). Both commit with the row itself.
      const updatedMaster = await database.$transaction(async (tx) => {
        const updated = await this.user.updateUser(
          { userId: masterUserId, userData: updateData },
          tx,
        );

        const changes = this.buildChangeSummary(
          masterUser,
          updated,
          !!rawPassword,
        );

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
        !!rawPassword,
      );

      if (rawPassword || data.email) {
        sendSecurityEventToUser(masterUserId, { reason: "user_updated" });
      }

      void this.sendUpdateEmail(
        masterUser,
        updatedMaster,
        changes,
        rawPassword,
        performingUser.name,
        performingUser.email,
      );

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
