import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import authConfig from "@/config/auth";
import { deleteInBatches } from "@/shared/database/batch-delete";
import { hashSingleUseToken } from "@/shared/security/single-use-token";
import {
  IUsersTokensRepository,
  MAX_EXPIRED_REFRESH_TOKENS_PER_RUN,
  REFRESH_GRACE_MAX_SIBLINGS,
  type RefreshTokenPurgeLimits,
  type RefreshTokenPurgeResult,
} from "./IUsers-tokens-repository";

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
  UserDeviceSession,
  UserOwnSession,
  UserSessionFamily,
} from "../dtos/user-tokens-dto";
import { groupDeviceSessions } from "../services/device-sessions";
import { hashDeviceId } from "../services/session-service";
import { groupOwnSessions, sessionFamilyOf } from "../services/own-sessions";

/**
 * The longest a session of any client may go unused before its refresh token
 * lapses. Read from the policies rather than copied, so a new or longer
 * policy (the driver's device session, D03) widens the push-device purge
 * with it instead of cutting a live login's pushes.
 */
function longestSessionIdleMs(): number {
  return (
    Math.max(
      ...Object.values(authConfig.refresh_policies).map(
        (policy) => policy.idleSeconds,
      ),
    ) * 1000
  );
}

class UserTokensRepository implements IUsersTokensRepository {
  constructor(private prisma = database) {}

  async createUserRefreshToken({
    token_hash,
    expires_in,
    userId,
    jti,
    family_id,
    device_id,
  }: CreateUserRefreshTokenProps): Promise<UserRefreshTokenProps> {
    const createUserRefreshToken = await this.prisma.refreshToken.create({
      data: {
        userId,
        token_hash,
        expires_in,
        jti,
        family_id,
        device_id: device_id ?? null,
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

      /**
       * A bounded number of siblings per spent token, not one per
       * presentation.
       *
       * The grace exists for a session racing itself — tabs, the parallel
       * requests of one page whose access token just expired, a retried
       * answer. It used to mint a live token on EVERY presentation inside the
       * window, so a copy replayed moments after the legitimate rotation got
       * a working session each time and the reuse alarm never rang. A cap of
       * one was too tight the other way: the third parallel renewal of one
       * page became "reuse" and logged the person out everywhere. The
       * conditional update is the lock, like the rotation's: racing late
       * presentations serialize on the row, each re-reads the count after
       * the previous commit, and the one past the cap is reuse.
       */
      const graced = await transaction.refreshToken.updateMany({
        where: {
          userId: user_id,
          jti: current_jti,
          token_hash: current_token_hash,
          grace_siblings: { lt: REFRESH_GRACE_MAX_SIBLINGS },
        },
        data: { grace_siblings: { increment: 1 } },
      });

      if (graced.count !== 1) return { outcome: "reused" };

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

  async listUserDeviceSessions(
    userId: string,
    now = new Date(),
  ): Promise<UserDeviceSession[]> {
    // Served by (userId, family_id): a user has a handful of rows.
    const live = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        device_id: { not: null },
        revoked_at: null,
        expires_in: { gt: now },
      },
      select: {
        device_id: true,
        family_id: true,
        created_at: true,
        expires_in: true,
      },
    });

    return groupDeviceSessions(live);
  }

  async findLoginsSignedInOnDevice(
    userIds: string[],
    deviceId: string,
    now = new Date(),
  ): Promise<string[]> {
    // Served by (userId, family_id): a CPF names a few logins, each with a
    // handful of rows. Asked even with no login, like the trust it backs.
    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId: { in: userIds },
        device_id: deviceId,
        revoked_at: null,
        expires_in: { gt: now },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    return rows.map((row) => row.userId);
  }

  async revokeUserDeviceSessions(
    userId: string,
    deviceHash: string,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (transaction) => {
      // The column holds the id, the caller the hash: a user's phone rows
      // are a handful, so they are hashed here (served by (userId, …)).
      const bound = await transaction.refreshToken.findMany({
        where: { userId, device_id: { not: null } },
        select: { family_id: true, device_id: true },
      });

      const familyIds = [
        ...new Set(
          bound
            .filter((row) => hashDeviceId(row.device_id!) === deviceHash)
            .map((row) => row.family_id),
        ),
      ];

      if (familyIds.length === 0) return [];

      // The whole family, every row of it (a session may have older rows
      // without the phone, from before the column), and its push devices,
      // as the logout does.
      await transaction.refreshToken.deleteMany({
        where: { userId, family_id: { in: familyIds } },
      });
      await transaction.pushDeviceToken.deleteMany({
        where: { userId, session_family_id: { in: familyIds } },
      });

      return familyIds;
    });
  }

  async listUserSessions(
    userId: string,
    now = new Date(),
  ): Promise<UserOwnSession[]> {
    // Served by (userId, family_id): a person has a handful of rows.
    const live = await this.prisma.refreshToken.findMany({
      where: { userId, revoked_at: null, expires_in: { gt: now } },
      select: {
        family_id: true,
        device_id: true,
        created_at: true,
        expires_in: true,
      },
    });

    if (live.length === 0) return [];

    const pushed = await this.prisma.pushDeviceToken.findMany({
      where: {
        userId,
        session_family_id: {
          in: [...new Set(live.map((row) => row.family_id))],
        },
      },
      select: { session_family_id: true },
    });

    return groupOwnSessions(
      live,
      new Set(
        pushed
          .map((row) => row.session_family_id)
          .filter((id): id is string => id !== null),
      ),
    );
  }

  async findSessionFamily(
    userId: string,
    familyId: string,
    now = new Date(),
  ): Promise<UserSessionFamily | null> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, family_id: familyId },
      select: {
        device_id: true,
        created_at: true,
        revoked_at: true,
        expires_in: true,
      },
    });

    return sessionFamilyOf(familyId, rows, now);
  }

  async revokeUserSession(
    userId: string,
    familyId: string,
  ): Promise<{ ended: boolean; deviceId: string | null }> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const rows = await transaction.refreshToken.findMany({
        where: { userId, family_id: familyId },
        select: { device_id: true, revoked_at: true, expires_in: true },
      });

      // Only a live session ends: one already over (its rows spent or
      // lapsed, waiting for the purge) changes nothing — not even the trust
      // of the phone it was on.
      const live = rows.some(
        (row) => row.revoked_at === null && row.expires_in > now,
      );

      if (!live) return { ended: false, deviceId: null };

      // The whole family and its push devices, as the logout does; scoped by
      // the user, so another person's session id ends nothing.
      await transaction.refreshToken.deleteMany({
        where: { userId, family_id: familyId },
      });
      await transaction.pushDeviceToken.deleteMany({
        where: { userId, session_family_id: familyId },
      });

      return {
        ended: true,
        deviceId: rows.find((row) => row.device_id)?.device_id ?? null,
      };
    });
  }

  async deleteExpiredUserRefreshTokens(
    now = new Date(),
    {
      maxRows = MAX_EXPIRED_REFRESH_TOKENS_PER_RUN,
      deadline = Number.POSITIVE_INFINITY,
    }: RefreshTokenPurgeLimits = {},
  ): Promise<RefreshTokenPurgeResult> {
    // Oldest first over refresh_token (expires_in): each batch stops at its
    // limit, and every row it meets is expired. A live token is never
    // matched, whatever the ceiling.
    return deleteInBatches({
      table: Prisma.sql`"refresh_token"`,
      where: Prisma.sql`"expires_in" < ${now}`,
      orderBy: Prisma.sql`"expires_in"`,
      maxRows,
      deadline,
      client: this.prisma,
    });
  }

  async deleteOrphanPushTokens(now = new Date()): Promise<number> {
    // Served by refresh_token (family_id, …): one probe per device row, and
    // the table has one row per phone.
    const ended = await this.prisma.$executeRaw`
      DELETE FROM "push_device_token" AS device
      WHERE device."session_family_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "refresh_token" AS session
          WHERE session."family_id" = device."session_family_id"
        )
    `;

    // Rows without a family predate the column (plan of 02/11/2026, A9):
    // they had no session to end with, so the delete above never reached
    // them and they kept receiving the user's pushes for good. The app
    // registers on every launch, which ties the row to its session and moves
    // updated_at; a row still without one, unseen for longer than any session
    // may sit idle, belongs to a login that is certainly over.
    const unseenSince = new Date(now.getTime() - longestSessionIdleMs());

    const forgotten = await this.prisma.$executeRaw`
      DELETE FROM "push_device_token"
      WHERE "session_family_id" IS NULL
        AND "updated_at" < ${unseenSince}
    `;

    return ended + forgotten;
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
