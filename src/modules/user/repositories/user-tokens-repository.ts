import database from "@/../infra/database";
import { hashSingleUseToken } from "@/shared/security/single-use-token";
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
  RefreshRotation,
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
    grace_ms,
  }: RotateUserRefreshTokenProps): Promise<RefreshRotation> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();

      // The conditional update is the lock: of two requests racing on the same
      // token, exactly one sees it live. The other waits for that commit,
      // re-reads the row, and lands in the branch below.
      const rotated = await transaction.refreshToken.updateMany({
        where: {
          userId: user_id,
          jti: current_jti,
          token_hash: current_token_hash,
          revoked_at: null,
          expires_in: { gt: now },
        },
        data: {
          revoked_at: now,
          replaced_by_jti: replacement.jti,
        },
      });

      if (rotated.count === 1) {
        const token = await transaction.refreshToken.create({
          data: replacement,
        });

        return { outcome: "rotated", token };
      }

      const presented = await transaction.refreshToken.findFirst({
        where: {
          userId: user_id,
          jti: current_jti,
          token_hash: current_token_hash,
        },
        select: { revoked_at: true, replaced_by_jti: true, expires_in: true },
      });

      if (!presented) return { outcome: "unknown" };

      // Never spent, yet the update above missed it, or lapsed whatever its
      // state: a session that ended, not a replay. The row expires with the
      // JWT, so a lapsed row here is a JWT that passed `verify` in its last
      // moment and reached this row a few milliseconds late — alone, or just
      // after a sibling rotated it. Calling it theft logged the person out of
      // every device.
      if (presented.revoked_at === null || presented.expires_in <= now) {
        return { outcome: "unknown" };
      }

      const spentMomentsAgo =
        presented.revoked_at !== null &&
        presented.replaced_by_jti !== null &&
        presented.expires_in > now &&
        now.getTime() - presented.revoked_at.getTime() < grace_ms;

      if (!spentMomentsAgo) return { outcome: "reused" };

      const token = await transaction.refreshToken.create({
        data: replacement,
      });

      return { outcome: "raced", token };
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
    // The session's devices go with it: a logged-out phone must stop showing
    // this user's messages even when the app's own unregister lost the race
    // to this very revoke, or was never sent (forced or offline logout).
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({
        where: { family_id: familyId },
      }),
      this.prisma.pushDeviceToken.deleteMany({
        where: { session_family_id: familyId },
      }),
    ]);
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { userId } }),
      this.prisma.pushDeviceToken.deleteMany({ where: { userId } }),
    ]);
  }

  async deleteExpiredUserRefreshTokens(now = new Date()): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expires_in: { lt: now } },
    });

    return result.count;
  }

  async deleteOrphanPushTokens(): Promise<number> {
    // Served by refresh_token (family_id, …): one probe per device row, and
    // the table has one row per phone. Rows without a family predate the
    // column and are left alone; the app re-registers them on launch.
    return this.prisma.$executeRaw`
      DELETE FROM "push_device_token" AS device
      WHERE device."session_family_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "refresh_token" AS session
          WHERE session."family_id" = device."session_family_id"
        )
    `;
  }

  async createEmailVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    // Only the hash is stored: the returned row's `token` is NOT the link's.
    const tokenHash = hashSingleUseToken(token);

    const upsertedVerificationToken =
      await this.prisma.emailVerificationToken.upsert({
        where: { email },
        update: { token: tokenHash, expires },
        create: { email, token: tokenHash, expires },
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
        where: { token: hashSingleUseToken(token) },
      });

    return findVerificationTokenByToken;
  }

  async consumeEmailVerificationToken(tokenId: string): Promise<boolean> {
    // `deleteMany` and not `delete`: `delete` throws when the row is already
    // gone, and "someone else spent this token" is an answer, not a fault.
    const { count } = await this.prisma.emailVerificationToken.deleteMany({
      where: { id: tokenId },
    });

    return count === 1;
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
      // A NEW code starts from zero; otherwise it inherits the previous
      // code's count and locks out the legitimate user. Requesting codes is
      // rate limited on its own.
      update: { token, expires, attempts: 0 },
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

  async consumeTwoFactorToken(twoFactorId: string): Promise<boolean> {
    const { count } = await this.prisma.twoFactorToken.deleteMany({
      where: { id: twoFactorId },
    });

    return count === 1;
  }

  async deleteTwoFactorToken(twoFactorId: string): Promise<void> {
    await this.prisma.twoFactorToken.delete({
      where: {
        id: twoFactorId,
      },
    });
  }

  async countTwoFactorAttempt(twoFactorId: string): Promise<number> {
    const updated = await this.prisma.twoFactorToken.update({
      where: { id: twoFactorId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    return updated.attempts;
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
    // Only the hash is stored: the returned row's `token` is NOT the link's.
    const tokenHash = hashSingleUseToken(token);

    const upsertedForgotPasswordVerificationToken =
      await this.prisma.forgotPasswordVerificationToken.upsert({
        where: { email },
        update: { token: tokenHash, expires },
        create: { email, token: tokenHash, expires },
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
        where: { token: hashSingleUseToken(token) },
      });

    return findForgotPasswordVerificationTokenByToken;
  }

  async consumeForgotPasswordVerificationToken(
    tokenId: string,
  ): Promise<boolean> {
    const { count } =
      await this.prisma.forgotPasswordVerificationToken.deleteMany({
        where: { id: tokenId },
      });

    return count === 1;
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
