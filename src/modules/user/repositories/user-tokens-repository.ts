import database from "@/../infra/database";
import { IUsersTokensRepository } from "./IUsers-tokens-repository";

import {
  CreateUserRefreshTokenProps,
  UserRefreshTokenProps,
  CreateVerificationToken,
  VerificationToken,
  TokenByIdAndRefreshTokenProps,
  TwoFactor,
  TwoFactorConfirmation,
  CreateTwoFactorToken,
} from "../dtos/user-tokens-dto";

class UserTokensRepository implements IUsersTokensRepository {
  constructor(private prisma = database) {}

  async createUserRefreshToken({
    refresh_token,
    expires_in,
    userId,
  }: CreateUserRefreshTokenProps): Promise<UserRefreshTokenProps> {
    const createUserRefreshToken = await this.prisma.refreshToken.create({
      data: {
        userId,
        refresh_token,
        expires_in,
      },
    });

    return createUserRefreshToken;
  }

  async findUserTokenByIdAndRefreshToken({
    user_id,
    refresh_token,
  }: TokenByIdAndRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    const findUserTokenById = await this.prisma.refreshToken.findFirst({
      where: {
        userId: user_id,
        refresh_token,
      },
    });

    return findUserTokenById;
  }

  async deleteUserRefreshTokenById(refreshTokenId: string): Promise<void> {
    await this.prisma.refreshToken.delete({
      where: {
        id: refreshTokenId,
      },
    });
  }

  async createEmailVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    const createVerificationToken =
      await this.prisma.emailVerificationToken.create({
        data: {
          email,
          token,
          expires,
        },
      });

    return createVerificationToken;
  }

  async findEmailVerificationTokenByEmail(
    email: string,
  ): Promise<VerificationToken | null> {
    const findVerificationTokenByEmail =
      await this.prisma.emailVerificationToken.findUnique({
        where: { email },
      });

    return findVerificationTokenByEmail;
  }

  async findEmailVerificationTokenByToken(
    token: string,
  ): Promise<VerificationToken | null> {
    const findVerificationTokenByToken =
      await this.prisma.emailVerificationToken.findUnique({
        where: { token },
      });

    return findVerificationTokenByToken;
  }

  async deleteEmailVerificationToken(tokenId: string): Promise<void> {
    await this.prisma.emailVerificationToken.delete({
      where: {
        id: tokenId,
      },
    });
  }

  async createTwoFactorToken({
    email,
    expires,
    token,
  }: CreateTwoFactorToken): Promise<TwoFactor> {
    const createTwoFactorToken = await this.prisma.twoFactorToken.create({
      data: {
        email,
        expires,
        token,
      },
    });

    return createTwoFactorToken;
  }

  async findTwoFactorTokenByEmail(email: string): Promise<TwoFactor | null> {
    const findTwoFactorByEmail = await this.prisma.twoFactorToken.findUnique({
      where: {
        email,
      },
    });

    return findTwoFactorByEmail;
  }

  async deleteTwoFactorToken(twoFactorId: string): Promise<void> {
    await this.prisma.twoFactorToken.delete({
      where: {
        id: twoFactorId,
      },
    });
  }

  async createTwoFactorConfirmation(
    userId: string,
  ): Promise<TwoFactorConfirmation> {
    const createTwoFactorConfirmation =
      await this.prisma.twoFactorConfirmation.create({
        data: {
          userId,
        },
      });

    return createTwoFactorConfirmation;
  }

  async findTwoFactorConfirmationByUserId(
    userId: string,
  ): Promise<TwoFactorConfirmation | null> {
    const findTwoFactorConfirmationByUserId =
      await this.prisma.twoFactorConfirmation.findUnique({
        where: {
          userId,
        },
      });

    return findTwoFactorConfirmationByUserId;
  }

  async deleteTwoFactorConfirmation(
    twoFactorConfirmationId: string,
  ): Promise<void> {
    await this.prisma.twoFactorConfirmation.delete({
      where: {
        id: twoFactorConfirmationId,
      },
    });
  }

  async createForgotPasswordVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    const createForgotPasswordVerificationToken =
      await this.prisma.forgotPasswordVerificationToken.create({
        data: {
          email,
          token,
          expires,
        },
      });

    return createForgotPasswordVerificationToken;
  }

  async findForgotPasswordVerificationTokenByEmail(
    email: string,
  ): Promise<VerificationToken | null> {
    const findForgotPasswordVerificationTokenByEmail =
      await this.prisma.forgotPasswordVerificationToken.findUnique({
        where: { email },
      });

    return findForgotPasswordVerificationTokenByEmail;
  }

  async findForgotPasswordVerificationTokenByToken(
    token: string,
  ): Promise<VerificationToken | null> {
    const findForgotPasswordVerificationTokenByToken =
      await this.prisma.forgotPasswordVerificationToken.findUnique({
        where: { token },
      });

    return findForgotPasswordVerificationTokenByToken;
  }

  async deleteForgotPasswordVerificationToken(tokenId: string): Promise<void> {
    await this.prisma.forgotPasswordVerificationToken.delete({
      where: {
        id: tokenId,
      },
    });
  }
}

export { UserTokensRepository };
