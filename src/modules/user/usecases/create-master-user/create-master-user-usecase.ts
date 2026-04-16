import { hash } from "bcrypt";
import { inject, injectable } from "tsyringe";

import { v4 as uuidV4 } from "uuid";

import { IUserRepository } from "../../repositories/IUser-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { CreateMasterUserProps, User } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserCannotCreateMasterUserError } from "../errors/user-cannot-create-master-user-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { env } from "@/env";

@injectable()
class CreateMasterUserUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private http_request = env.HTTP_REQUEST;

  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {
    this.emailQueue = new EmailWorkerAdapter("createMasterUserEmailQueue");
  }

  private buildMasterUserCreatedNotificationText({
    masterName,
    masterEmail,
  }: {
    masterName: string;
    masterEmail: string;
  }): string {
    return [
      `👤 *Novo Usuário Master Criado!*`,
      `Nome: *${masterName}*`,
      `E-mail: *${masterEmail}*`,
      `As credenciais foram enviadas por e-mail.`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    masterCreated: User,
    rawPassword: string,
    performedById: string,
    performingUserName: string,
    performingUserEmail: string,
  ): Promise<void> {
    try {
      const token = uuidV4();
      const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour

      const verificationToken =
        await this.usersTokens.createEmailVerificationToken({
          email: masterCreated.email,
          token,
          expires,
        });

      // Send credentials email and verification email in parallel
      await Promise.all([
        this.emailQueue.enqueueEmail({
          email: masterCreated.email,
          name: masterCreated.name,
          subject: "Sua conta Master foi criada com sucesso",
          templateName: "user-created-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            email: masterCreated.email,
            password: rawPassword,
            logo: this.cloudinaryLogo,
          },
        }),
        this.emailQueue.enqueueEmail({
          email: masterCreated.email,
          name: masterCreated.name,
          subject: "Verificação de e-mail",
          templateName: "email-verification.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            url: `${this.http_request}/new-verification?token=${verificationToken.token}`,
            logo: this.cloudinaryLogo,
          },
        }),
      ]);

      // Activity + notification for the creator (performing MASTER)
      await this.notificationService.processUserNotifications({
        activity: {
          type: "Usuário",
          action: "create",
          entityId: masterCreated.id,
          description: `Usuário Master ${masterCreated.name} criado | E-mail não verificado: ${masterCreated.email}`,
          status: "Pendente",
          performedBy: performedById,
          businessId: null,
          visibilityLevel: "SYSTEM",
        },
        notification: {
          userId: performedById,
          type: "master-user",
          title: "Novo Usuário Master Criado",
          message: `Você criou o usuário Master ${masterCreated.name} (${masterCreated.email}).`,
          entityId: masterCreated.id,
          link: `${this.http_request}/admin/master-users?search=${masterCreated.id}&page=1`,
          businessId: null,
          shouldSendEmail: true,
          shouldSendWhatsApp: true,
          whatsAppMessage: this.buildMasterUserCreatedNotificationText({
            masterName: masterCreated.name,
            masterEmail: masterCreated.email,
          }),
        },
      });

      // Notification for the created MASTER user
      await this.notificationService.createNotificationIfEnabled({
        userId: masterCreated.id,
        type: "master-user",
        title: "Bem-vindo ao Trajetto",
        message: `Sua conta Master foi criada por ${performingUserName} (${performingUserEmail}). Suas credenciais foram enviadas por e-mail.`,
        entityId: masterCreated.id,
        link: `${this.http_request}/admin`,
        businessId: null,
        shouldSendEmail: false,
      });
    } catch (error) {
      console.error("[Usuário Master] Erro ao processar notificações:", error);
    }
  }

  async execute(
    { name, email, password }: CreateMasterUserProps,
    performedById: string,
  ): Promise<User> {
    // Validate the performing user exists and is MASTER
    const performingUser = await this.user.findUserById(performedById);

    if (!performingUser) {
      throw new ResourceNotFoundError();
    }

    if (performingUser.role !== "MASTER") {
      throw new UserCannotCreateMasterUserError();
    }

    // Check if email already exists
    const userAlreadyExists = await this.user.findUserByEmail(email);

    if (userAlreadyExists) {
      throw new UserAlreadyExistsError();
    }

    const hashedPassword = await hash(password, 10);

    try {
      const masterCreated = await this.user.createMasterUser({
        name,
        email,
        password: hashedPassword,
      });

      // Process notifications asynchronously without blocking the main flow
      this.processNotifications(
        masterCreated,
        password,
        performedById,
        performingUser.name,
        performingUser.email,
      );

      return masterCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o usuário Master! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateMasterUserUseCase };
