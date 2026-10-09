import { inject, injectable } from "tsyringe";
import { v4 as uuidV4 } from "uuid";

import { env } from "@/env";
import { IUserRepository } from "../../repositories/IUser-repository";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";

const log = logger.child({ component: "user" });

@injectable()
class SendForgotPasswordMailUseCase {
  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(email: string): Promise<void> {
    const findUserByEmail = await this.user.findUserByEmail(email);

    // Nothing to send, and the caller gets the same answer as everyone else.
    if (!findUserByEmail || findUserByEmail.access_revoked) return;

    const findExistingToken =
      await this.usersTokens.findForgotPasswordVerificationTokenByEmail(email);

    if (findExistingToken) {
      await this.usersTokens.deleteForgotPasswordVerificationToken(
        findExistingToken.id,
      );
    }

    const token = uuidV4();
    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour in milliseconds

    try {
      await this.usersTokens.createForgotPasswordVerificationToken({
        email,
        expires,
        token,
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o e-mail correspondente a um endereço cadastrado! Por favor, tente novamente.",
        500,
      );
    }

    /**
     * Sent after the answer, never before it (GAP3-11, AUTH-06).
     *
     * An unknown address returned at once, while a registered one waited for
     * the provider — hundreds of milliseconds — and a provider failure was a
     * 500 for registered addresses only. The same sentence for both was
     * undone by the clock and the status code. The link is stored above, so
     * a lost e-mail costs one more request. It carries the reset secret, so
     * it stays in-process and never rides the outbox.
     */
    // The link carries the local token: the row only holds its hash.
    void sendTransactionalMail({
      email,
      name: findUserByEmail.name,
      subject: "Solicitação de redefinição de senha",
      templateName: "forgot-password.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        url: `${this.http_request}/forgot/password?token=${token}`,
        logo: this.cloudinaryLogo,
      },
    }).catch((error) =>
      // The provider's error is already redacted (no address); the user id
      // says whose link it was without writing the typed address anywhere.
      log.error(
        { err: error, userId: findUserByEmail.id },
        "password reset e-mail could not be sent",
      ),
    );
  }
}

export { SendForgotPasswordMailUseCase };
