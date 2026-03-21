import { inject, injectable } from "tsyringe";
import { verify, sign } from "jsonwebtoken";

import auth from "@/config/auth";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { IUserRepository } from "../../repositories/IUser-repository";

import { UserRefreshTokenNotExistsError } from "../errors/user-refresh-token-not-exists-error";
import { UserInvalidCredentialsError } from "../errors/user-invalid-credentials-error";

import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";
import { UserRevokedAccessError } from "../errors/user-revoked-access-error";

import { AppError } from "@/shared/errors/AppError";

interface RefreshTokenProps {
  token: string;
  refresh_token: string;
}

interface IPayload {
  sub: string;
  email: string;
}

@injectable()
class RefreshTokenUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(token: string): Promise<RefreshTokenProps> {
    const { sub: user_id, email } = verify(
      token,
      auth.secret_refresh_token,
    ) as IPayload;

    const findUserByEmail = await this.user.findUserByEmail(email);

    if (!findUserByEmail) {
      throw new UserInvalidCredentialsError();
    }

    // Check if user access has been revoked
    if (findUserByEmail.access_revoked) {
      throw new UserRevokedAccessError();
    }

    const userToken = await this.usersTokens.findUserTokenByIdAndRefreshToken({
      user_id,
      refresh_token: token,
    });

    if (!userToken) {
      throw new UserRefreshTokenNotExistsError();
    }

    await this.usersTokens.deleteUserRefreshTokenById(userToken.id);

    // BUSINESS_USER must have either profileAccess OR driverId
    if (findUserByEmail.role === "BUSINESS_USER") {
      const hasProfileAccess =
        findUserByEmail.profileAccess &&
        findUserByEmail.profileAccess.permissions &&
        findUserByEmail.profileAccess.permissions.length > 0;

      const hasDriverId = !!findUserByEmail.driverId;

      // If doesn't have profileAccess and doesn't have driverId, throw error
      if (!hasProfileAccess && !hasDriverId) {
        throw new UserNotFoundPermissionOrProfileAccess();
      }
    }

    const {
      secret_refresh_token,
      expires_in_token,
      secret_token,
      expires_in_refresh_token,
      expires_in_refresh_token_days,
    } = auth;

    const newToken = sign(
      {
        role: findUserByEmail.role,
        driverId: findUserByEmail.driverId || null,
      },
      secret_token,
      {
        subject: user_id,
        expiresIn: expires_in_token,
      },
    );

    const refresh_token = sign({ email }, secret_refresh_token, {
      subject: user_id,
      expiresIn: expires_in_refresh_token,
    });

    const expires_in = new Date(
      new Date().getTime() + expires_in_refresh_token_days,
    );

    try {
      await this.usersTokens.createUserRefreshToken({
        userId: user_id,
        expires_in,
        refresh_token,
      });

      return {
        refresh_token,
        token: newToken,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar entrar na sua conta! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RefreshTokenUseCase };
