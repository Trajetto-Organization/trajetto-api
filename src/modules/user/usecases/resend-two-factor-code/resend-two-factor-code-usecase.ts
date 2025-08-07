import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { ResendTwoFactorError } from "../errors/resend-two-factor-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";

interface ResendTwoFactorCodeProps {
  twoFactorVerificationMessage: string;
}

@injectable()
class ResendTwoFactorCodeUseCase {
  private emailQueue: EmailWorkerAdapter;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,

    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("resendTwoFactorCodeQueue");
  }

  async execute(email: string): Promise<ResendTwoFactorCodeProps> {
    const findUser = await this.user.findUserByEmail(email);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.two_factor_enabled) {
      throw new ResendTwoFactorError();
    }

    const existingTwoFactorTokenByEmail =
      await this.usersTokens.findTwoFactorTokenByEmail(findUser.email);

    if (existingTwoFactorTokenByEmail) {
      await this.usersTokens.deleteTwoFactorToken(
        existingTwoFactorTokenByEmail.id,
      );
    }

    const twoFactorConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(findUser.id);

    if (twoFactorConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        twoFactorConfirmation.id,
      );
    }

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    const twoFactorExpires = new Date(new Date().getTime() + 15 * 60 * 1000); // 15 minutes in milliseconds

    try {
      await this.usersTokens.createTwoFactorToken({
        email: email,
        token: hashedTwoFactorToken,
        expires: twoFactorExpires,
      });

      await this.emailQueue.enqueueEmail({
        email,
        name: findUser.name,
        subject: "Two factor verification code",
        templateName: "two-factor-verification-code.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          token: twoFactorToken,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        twoFactorVerificationMessage:
          "Um código de verificação foi reenviado para este e-mail!",
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ResendTwoFactorCodeUseCase };
