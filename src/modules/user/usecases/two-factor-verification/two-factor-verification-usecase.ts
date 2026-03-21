import { inject, injectable } from "tsyringe";

import { compare } from "bcrypt";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidTwoFactorCodeError } from "../errors/user-invalid-two-factor-code-error";
import { UserExpiredCodeError } from "../errors/user-expired-code-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserInvalidCodeForUserError } from "../errors/user-invalid-code-for-user-error";

import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";
import { AppError } from "@/shared/errors/AppError";

interface TwoFactorVerificationQueryProps {
  twoFactorCode: string;
  email: string;
}

interface TwoFactorVerificationProps {
  token: string;
  refresh_token: string;
  role?: string;
}

@injectable()
class TwoFactorVerificationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute({
    twoFactorCode,
    email,
  }: TwoFactorVerificationQueryProps): Promise<TwoFactorVerificationProps> {
    if (!email) throw new ResourceNotFoundError();

    // Find 2FA token using email
    const twoFactorToken =
      await this.usersTokens.findTwoFactorTokenByEmail(email);

    if (!twoFactorToken) throw new UserInvalidTwoFactorCodeError();

    const user = await this.user.findUserByEmail(twoFactorToken.email);
    if (!user) throw new ResourceNotFoundError();

    /* c8 ignore next */
    if (user.email !== email) throw new UserInvalidCodeForUserError();

    // Checks if the provided code matches the stored code
    const isCodeValid = await compare(twoFactorCode, twoFactorToken.token);
    if (!isCodeValid) throw new UserInvalidTwoFactorCodeError();

    const now = new Date();

    // Checks if the token has expired
    if (now > twoFactorToken.expires) throw new UserExpiredCodeError();

    await this.usersTokens.deleteTwoFactorToken(twoFactorToken.id);

    const existingConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(user.id);

    if (existingConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        existingConfirmation.id,
      );
    }

    try {
      await this.usersTokens.createTwoFactorConfirmation(user.id);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar confirmar a sua verificação de dois fatores! Por favor, tente novamente.",
        500,
      );
    }

    // BUSINESS_USER must have either profileAccess OR driverId
    if (user.role === "BUSINESS_USER") {
      const hasProfileAccess =
        user.profileAccess &&
        user.profileAccess.permissions &&
        user.profileAccess.permissions.length > 0;

      const hasDriverId = !!user.driverId;

      // If doesn't have profileAccess and doesn't have driverId, throw error
      if (!hasProfileAccess && !hasDriverId) {
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
        role: user.role,
        driverId: user.driverId || null,
      },
      secret_token,
      {
        subject: user.id,
        expiresIn: expires_in_token,
      },
    );

    const refresh_token = sign({ email: user.email }, secret_refresh_token, {
      subject: user.id,
      expiresIn: expires_in_refresh_token,
    });

    const expires_in = new Date(
      new Date().getTime() + expires_in_refresh_token_days,
    );

    try {
      await this.usersTokens.createUserRefreshToken({
        userId: user.id,
        expires_in,
        refresh_token,
      });

      return { token, refresh_token, role: user.role };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar entrar na sua conta! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { TwoFactorVerificationUseCase };
