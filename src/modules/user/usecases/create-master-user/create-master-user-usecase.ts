import { hash } from "bcrypt";
import { inject, injectable } from "tsyringe";

import { v4 as uuidV4 } from "uuid";

import { IUserRepository } from "../../repositories/IUser-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";

import { AppError } from "@/shared/errors/AppError";
import { CreateMasterUserProps, User } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserCannotCreateMasterUserError } from "../errors/user-cannot-create-master-user-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { env } from "@/env";

@injectable()
class CreateMasterUserUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  /**
   * Credential and verification e-mails stay here rather than in the
   * notification pipeline: the first one carries the plain password, which
   * must never sit in a persisted outbox payload.
   */
  private async sendCredentialEmails(
    masterCreated: User,
    rawPassword: string,
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

      await Promise.all([
        sendTransactionalMail({
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
        sendTransactionalMail({
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
    } catch (error) {
      console.error("[Usuário Master] Erro ao enviar e-mails:", error);
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
      // Two audiences, two events: the performer hears "you created X", the
      // new master hears "welcome". Both commit with the user row itself.
      const masterCreated = await database.$transaction(async (tx) => {
        const created = await this.user.createMasterUser(
          { name, email, password: hashedPassword },
          tx,
        );

        await this.outbox.publish(tx, {
          topic: "master-user.created",
          aggregateType: "master-user",
          aggregateId: created.id,
          actorId: performedById,
          payload: {
            masterUserId: created.id,
            masterName: created.name,
            masterEmail: created.email,
            actorUserId: performedById,
          },
        });

        await this.outbox.publish(tx, {
          topic: "master-user.welcomed",
          aggregateType: "master-user",
          aggregateId: created.id,
          actorId: performedById,
          payload: {
            masterUserId: created.id,
            performingUserName: performingUser.name,
            performingUserEmail: performingUser.email,
          },
        });

        return created;
      });

      // Fire-and-forget as before; the plain password must not block nor
      // outlive this request in any persisted form.
      void this.sendCredentialEmails(masterCreated, password);

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
