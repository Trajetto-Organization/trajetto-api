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
  RotateUserRefreshTokenProps,
} from "../dtos/user-tokens-dto";

class UserTokensRepository implements IUsersTokensRepository {
  constructor(private prisma = database) {}

  async createUserRefreshToken({
    token_hash,
    expires_in,
    userId,
    jti,
    family_id,
  }: CreateUserRefreshTokenProps): Promise<UserRefreshTokenProps> {
    const createUserRefreshToken = await this.prisma.refreshToken.create({
      data: {
        userId,
        token_hash,
        expires_in,
        jti,
        family_id,
      },
    });

    return createUserRefreshToken;
  }

  async findUserTokenByIdAndRefreshToken({
    user_id,
    token_hash,
    jti,
  }: TokenByIdAndRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    const findUserTokenById = await this.prisma.refreshToken.findFirst({
      where: {
        userId: user_id,
        token_hash,
        jti,
        revoked_at: null,
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

  async rotateUserRefreshToken({
    user_id,
    current_jti,
    current_token_hash,
    replacement,
  }: RotateUserRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    return this.prisma.$transaction(async (transaction) => {
      const rotated = await transaction.refreshToken.updateMany({
        where: {
          userId: user_id,
          jti: current_jti,
          token_hash: current_token_hash,
          revoked_at: null,
          expires_in: { gt: new Date() },
        },
        data: {
          revoked_at: new Date(),
          replaced_by_jti: replacement.jti,
        },
      });

      if (rotated.count !== 1) {
        return null;
      }

      return transaction.refreshToken.create({
        data: replacement,
      });
    });
  }

  async hasActiveRefreshTokenFamily(
    userId: string,
    familyId: string,
  ): Promise<boolean> {
    const activeToken = await this.prisma.refreshToken.findFirst({
      where: {
        userId,
        family_id: familyId,
        revoked_at: null,
        expires_in: { gt: new Date() },
      },
      select: { id: true },
    });

    return activeToken !== null;
  }

  async revokeUserRefreshTokenFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { family_id: familyId },
    });
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  async deleteExpiredUserRefreshTokens(now = new Date()): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expires_in: { lt: now } },
    });

    return result.count;
  }

  async createEmailVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    const upsertedVerificationToken =
      await this.prisma.emailVerificationToken.upsert({
        where: { email },
        update: { token, expires },
        create: { email, token, expires },
      });

    return upsertedVerificationToken;
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
    const upsertedTwoFactorToken = await this.prisma.twoFactorToken.upsert({
      where: { email },
      update: { token, expires },
      create: { email, token, expires },
    });

    return upsertedTwoFactorToken;
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
    const upsertedForgotPasswordVerificationToken =
      await this.prisma.forgotPasswordVerificationToken.upsert({
        where: { email },
        update: { token, expires },
        create: { email, token, expires },
      });

    return upsertedForgotPasswordVerificationToken;
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
