import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { compare } from "bcrypt";

import { v4 as uuidV4 } from "uuid";

import {
  AuthenticateUserProps,
  EmailVerificationProps,
  TwoFactorProps,
} from "./dtos/authenticate-user-dto";

import { AuthenticateUser } from "../../dtos/user-dto";
import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidCredentialsError } from "../errors/user-invalid-credentials-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { assertSessionEligible } from "../../services/session-eligibility";
import { createUserSession } from "../../services/session-service";

@injectable()
class AuthenticateUserUseCase {
  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("authenticateUserEmailQueue");
  }

  private async emailVerification({
    email,
    tokenVerification,
    name,
    expires,
  }: EmailVerificationProps) {
    try {
      const { token } = await this.usersTokens.createEmailVerificationToken({
        email: email,
        token: tokenVerification,
        expires,
      });

      await this.emailQueue.enqueueEmail({
        email,
        name,
        subject: "Verificação de e-mail",
        templateName: "email-verification.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          url: `${this.http_request}/new-verification?token=${token}`,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        emailVerificationMessage:
          "Um token de verificação foi enviado para este e-mail!",
        emailVerification: true,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async twoFactor({
    userId,
    email,
    name,
    hashedTwoFactorToken,
    twoFactorExpires,
    twoFactorToken,
  }: TwoFactorProps) {
    const twoFactorConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(userId);

    if (twoFactorConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        twoFactorConfirmation.id,
      );
    }

    try {
      await this.usersTokens.createTwoFactorToken({
        email: email,
        token: hashedTwoFactorToken,
        expires: twoFactorExpires,
      });

      await this.emailQueue.enqueueEmail({
        email,
        name,
        subject: "Código de verificação de dois fatores",
        templateName: "two-factor-verification-code.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          token: twoFactorToken,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        twoFactorVerificationMessage:
          "Um código de verificação foi enviado para este e-mail!",
        isTwoFactorVerification: true,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }
  }

  async execute(
    authenticateUser: AuthenticateUser,
  ): Promise<AuthenticateUserProps> {
    const { email, password } = authenticateUserSchema.parse(authenticateUser);
    const findUser = await this.user.findUserByEmail(email);

    if (!findUser) {
      throw new UserInvalidCredentialsError();
    }

    const doesPasswordMatches = await compare(password, findUser.password);

    if (!doesPasswordMatches) {
      throw new UserInvalidCredentialsError();
    }

    await assertSessionEligible(findUser, this.driver);

    const findExistingToken =
      await this.usersTokens.findEmailVerificationTokenByEmail(email);

    if (findExistingToken) {
      await this.usersTokens.deleteEmailVerificationToken(findExistingToken.id);
    }

    const tokenVerification = uuidV4();
    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour in milliseconds

    if (!findUser.email_verified) {
      return await this.emailVerification({
        email: findUser.email,
        name: findUser.name,
        tokenVerification,
        expires,
      });
    }

    const existingTwoFactorTokenByEmail =
      await this.usersTokens.findTwoFactorTokenByEmail(findUser.email);

    if (existingTwoFactorTokenByEmail) {
      await this.usersTokens.deleteTwoFactorToken(
        existingTwoFactorTokenByEmail.id,
      );
    }

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 10);

    const twoFactorExpires = new Date(new Date().getTime() + 15 * 60 * 1000); // 15 minutes in milliseconds

    if (findUser.two_factor_enabled) {
      return await this.twoFactor({
        email: findUser.email,
        name: findUser.name,
        userId: findUser.id,
        twoFactorExpires,
        hashedTwoFactorToken,
        twoFactorToken,
      });
    }

    const session = await createUserSession(findUser, this.usersTokens);

    return { ...session, role: findUser.role };
  }
}

export { AuthenticateUserUseCase };
