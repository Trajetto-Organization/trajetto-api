import { hashSecret } from "@/shared/security/bcrypt-gate";
import { inject, injectable } from "tsyringe";

import { v4 as uuidV4 } from "uuid";

import { IUserRepository } from "../../repositories/IUser-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";

import { AppError } from "@/shared/errors/AppError";
import { User } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserCannotCreateMasterUserError } from "../errors/user-cannot-create-master-user-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";
import { env } from "@/env";

import {
  NEW_ACCOUNT_LINK_TTL_MS,
  issuePasswordSetupLink,
  unusablePassword,
} from "../../services/password-setup-link";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { requireMailbox } from "../../services/user-mailbox";

const log = logger.child({ component: "user" });

@injectable()
class CreateMasterUserUseCase {
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
   * The welcome and verification e-mails stay here rather than in the
   * notification pipeline: they carry single-use secrets (the set-password
   * link, the verification link), which must never sit in a persisted outbox
   * payload. No password is mailed (decision 4.9).
   */
  private async sendCredentialEmails(masterCreated: User): Promise<void> {
    try {
      // Created a moment ago with the address typed (D2: only a driver's
      // login may have none).
      const mailbox = requireMailbox(masterCreated);
      const token = uuidV4();
      const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour

      // The link carries the local token: the row only holds its hash.
      await this.usersTokens.createEmailVerificationToken({
        email: mailbox,
        token,
        expires,
      });

      const setupUrl = await issuePasswordSetupLink(
        this.usersTokens,
        mailbox,
        NEW_ACCOUNT_LINK_TTL_MS,
      );

      await Promise.all([
        sendTransactionalMail({
          email: mailbox,
          name: masterCreated.name,
          subject: "Sua conta Master foi criada com sucesso",
          templateName: "user-created-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            email: mailbox,
            url: setupUrl,
            logo: emailLogoUrl(),
          },
        }),
        sendTransactionalMail({
          email: mailbox,
          name: masterCreated.name,
          subject: "Verificação de e-mail",
          templateName: "email-verification.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            url: `${this.http_request}/new-verification?token=${token}`,
            logo: emailLogoUrl(),
          },
        }),
      ]);
    } catch (error) {
      log.error(
        { err: error, userId: masterCreated.id },
        "master user credential e-mails could not be sent",
      );
    }
  }

  async execute(
    { name, email }: { name: string; email: string },
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

    // Nobody knows it: the new master sets theirs through the e-mailed link.
    const hashedPassword = await hashSecret(unusablePassword(), 10);

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
            masterEmail: email,
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
            performingUserEmail: requireMailbox(performingUser),
          },
        });

        return created;
      });

      // Fire-and-forget as before: a slow provider must not hold the answer.
      void this.sendCredentialEmails(masterCreated);

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
