import { hash } from "bcrypt";
import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { NotificationService } from "@/shared/services/notification-service";
import { UpdateMasterUserProps, User } from "../../dtos/user-dto";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserCannotUpdateMasterUserError } from "../errors/user-cannot-update-master-user-error";

import { UserIsNotMasterError } from "../errors/user-is-not-master-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { sendSecurityEventToUser } from "@/websocket";

import { env } from "@/env";

interface UpdateMasterUserExecuteProps {
  masterUserId: string;
  data: UpdateMasterUserProps;
  performedById: string;
}

interface ChangeSummary {
  /** Formatted for in-app notifications: "nome: X → Y, e-mail: A → B, senha" */
  notificationText: string;
  /** Formatted for activity log: same as notificationText */
  activityText: string;
  passwordChanged: boolean;
}

@injectable()
class UpdateMasterUserUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private http_request = env.HTTP_REQUEST;

  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {
    this.emailQueue = new EmailWorkerAdapter("updateMasterUserEmailQueue");
  }

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

  private async processNotifications(
    before: User,
    updatedMaster: User,
    changes: ChangeSummary,
    rawPassword: string | undefined,
    performedById: string,
    masterUserId: string,
    performingUserName: string,
    performingUserEmail: string,
  ): Promise<void> {
    try {
      const { notificationText, activityText, passwordChanged } = changes;

      // Activity + notification for the performer
      await this.notificationService.processUserNotifications({
        activity: {
          type: "Usuário",
          action: "update",
          entityId: updatedMaster.id,
          description: `Usuário Master ${updatedMaster.name} atualizado | Campos: ${activityText}`,
          status: "Atualizado",
          performedBy: performedById,
          businessId: null,
          visibilityLevel: "SYSTEM",
        },
        notification: {
          userId: performedById,
          type: "master-user",
          title: "Usuário Master Atualizado",
          message: `Você atualizou o usuário Master ${before.name}. Campos alterados: ${notificationText}.`,
          entityId: updatedMaster.id,
          link: `${this.http_request}/admin/master-users?search=${updatedMaster.id}&page=1`,
          businessId: null,
          shouldSendEmail: true,
          shouldSendWhatsApp: true,
          whatsAppMessage: this.buildWhatsAppText({
            masterName: updatedMaster.name,
            changesText: notificationText,
            performingUserName,
            performingUserEmail,
          }),
        },
      });

      // Notify and email the updated MASTER (only if different from performer)
      if (performedById !== masterUserId) {
        await this.notificationService.createNotificationIfEnabled({
          userId: masterUserId,
          type: "master-user",
          title: "Sua Conta Foi Atualizada",
          message: `${performingUserName} (${performingUserEmail}) atualizou sua conta. Campos alterados: ${notificationText}.`,
          entityId: updatedMaster.id,
          link: `${this.http_request}/profile`,
          businessId: null,
          shouldSendEmail: true,
          shouldSendWhatsApp: true,
          whatsAppMessage: this.buildWhatsAppText({
            masterName: updatedMaster.name,
            changesText: notificationText,
            performingUserName,
            performingUserEmail,
          }),
        });

        // Send update email to the updated Master with all changed fields
        // including new password in plain text when applicable
        await this.emailQueue.enqueueEmail({
          email: updatedMaster.email,
          name: updatedMaster.name,
          subject: "Sua conta Master foi atualizada",
          templateName: "master-user-updated.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            performingUserName,
            performingUserEmail,
            changesText: notificationText,
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
            ...(passwordChanged && rawPassword && { newPassword: rawPassword }),
            logo: this.cloudinaryLogo,
          },
        });
      }
    } catch (error) {
      console.error("[Usuário Master] Erro ao processar notificações:", error);
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
      updateData.password = await hash(rawPassword, 6);
    }

    try {
      const updatedMaster = await this.user.updateUser({
        userId: masterUserId,
        userData: updateData,
      });

      const changes = this.buildChangeSummary(
        masterUser,
        updatedMaster,
        !!rawPassword,
      );

      if (rawPassword || data.email) {
        sendSecurityEventToUser(masterUserId, { reason: "user_updated" });
      }

      // Process notifications asynchronously without blocking the main flow
      this.processNotifications(
        masterUser,
        updatedMaster,
        changes,
        rawPassword,
        performedById,
        masterUserId,
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
