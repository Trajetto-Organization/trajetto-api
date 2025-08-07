import { inject, injectable } from "tsyringe";
import { v4 as uuidV4 } from "uuid";

import { env } from "@/env";

import { IUserRepository } from "../../repositories/IUser-repository";

import { EmailNotFoundError } from "../errors/email-not-found-error";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { AppError } from "@/shared/errors/AppError";
import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";

@injectable()
class SendForgotPasswordMailUseCase {
  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("forgotPasswordUserEmailQueue");
  }

  async execute(email: string): Promise<void> {
    const findUserByEmail = await this.user.findUserByEmail(email);

    if (!findUserByEmail) {
      throw new EmailNotFoundError();
    }

    if (findUserByEmail.access_revoked) {
      throw new EmailNotFoundError();
    }

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
      const createForgotPasswordToken =
        await this.usersTokens.createForgotPasswordVerificationToken({
          email,
          expires,
          token,
        });

      await this.emailQueue.enqueueEmail({
        email,
        name: findUserByEmail.name,
        subject: "Solicitação de redefinição de senha",
        templateName: "forgot-password.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          url: `${this.http_request}/forgot/password?token=${createForgotPasswordToken.token}`,
          logo: this.cloudinaryLogo,
        },
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o e-mail correspondente a um endereço cadastrado! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { SendForgotPasswordMailUseCase };
