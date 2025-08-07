import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { sign } from "jsonwebtoken";
import { compare } from "bcrypt";

import { v4 as uuidV4 } from "uuid";
import auth from "@/config/auth";

import {
  AuthenticateUserProps,
  EmailVerificationProps,
  TwoFactorProps,
} from "./dtos/authenticate-user-dto";

import { AuthenticateUser } from "../../dtos/user-dto";

import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { InvalidCredentialsError } from "../errors/invalid-credentials-error";
import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { UserRevokedAccessError } from "../errors/user-revoked-access-error";

import { env } from "@/env";

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

    if (findUser?.access_revoked) {
      throw new UserRevokedAccessError();
    }

    if (!findUser) {
      throw new InvalidCredentialsError();
    }

    const doesPasswordMatches = await compare(password, findUser.password);

    if (!doesPasswordMatches) {
      throw new InvalidCredentialsError();
    }

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
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

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

    if (findUser.role === "BUSINESS_USER") {
      if (
        !findUser.profileAccess ||
        !findUser.profileAccess.permissions ||
        findUser.profileAccess.permissions.length === 0
      ) {
        throw new UserNotFoundPermissionOrProfileAccess();
      }
    }

    const {
      secret_token,
      secret_refresh_token,
      expires_in_token,
      expires_in_refresh_token,
      expires_in_refresh_token_days,
    } = auth;

    const token = sign(
      {
        role: findUser.role,
        businessId: findUser.businessId,
        profileAccess: findUser.profileAccess,
        permissions: findUser.profileAccess?.permissions,
      },
      secret_token,
      {
        subject: findUser.id,
        expiresIn: expires_in_token,
      },
    );

    const refresh_token = sign({ email }, secret_refresh_token, {
      subject: findUser.id,
      expiresIn: expires_in_refresh_token,
    });

    const expires_in = new Date(
      new Date().getTime() + expires_in_refresh_token_days,
    );

    try {
      await this.usersTokens.createUserRefreshToken({
        userId: findUser.id,
        expires_in,
        refresh_token,
      });

      return {
        token,
        refresh_token,
        role: findUser.role,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar entrar na sua conta! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { AuthenticateUserUseCase };
