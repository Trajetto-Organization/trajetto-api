import { v7 as uuidV7 } from "uuid";
import { hashSingleUseToken } from "@/shared/security/single-use-token";
import {
  IUsersTokensRepository,
  MAX_EXPIRED_REFRESH_TOKENS_PER_RUN,
  REFRESH_GRACE_MAX_SIBLINGS,
  type RefreshTokenPurgeLimits,
  type RefreshTokenPurgeResult,
} from "../IUsers-tokens-repository";

import {
  CreateUserRefreshTokenProps,
  TokenByIdAndRefreshTokenProps,
  UserRefreshTokenProps,
  CreateVerificationToken,
  VerificationToken,
  TwoFactor,
  TwoFactorConfirmation,
  CreateTwoFactorToken,
  RotateUserRefreshTokenProps,
  RefreshRotation,
  UserDeviceSession,
  UserOwnSession,
  UserSessionFamily,
} from "../../dtos/user-tokens-dto";
import { groupDeviceSessions } from "../../services/device-sessions";
import { hashDeviceId } from "../../services/session-service";
import { groupOwnSessions, sessionFamilyOf } from "../../services/own-sessions";

/** A push device as the session tables see it (Prisma: PushDeviceToken). */
interface PushDeviceRow {
  userId: string;
  session_family_id: string | null;
}

class InMemoryUserTokensRepository implements IUsersTokensRepository {
  public refreshTokenItems: UserRefreshTokenProps[] = [];

  /**
   * The push devices the sessions registered, for the session reads that
   * look at them (the own sessions' "app" kind and their revocation). Empty
   * unless a test seeds it.
   */
  public pushDeviceTokens: PushDeviceRow[] = [];
  public forgotPasswordVerificationTokens: VerificationToken[] = [];

  public emailVerificationTokens: VerificationToken[] = [];
  public twoFactorTokens: TwoFactor[] = [];

  public twoFactorConfirmationTokens: TwoFactorConfirmation[] = [];

  async createUserRefreshToken({
    token_hash,
    expires_in,
    userId,
    jti,
    family_id,
    device_id,
  }: CreateUserRefreshTokenProps): Promise<UserRefreshTokenProps> {
    const createRefreshToken: UserRefreshTokenProps = {
      id: uuidV7(),
      token_hash,
      expires_in,
      userId,
      jti,
      family_id,
      revoked_at: null,
      replaced_by_jti: null,
      grace_siblings: 0,
      device_id: device_id ?? null,
      created_at: new Date(),
    };

    this.refreshTokenItems.push(createRefreshToken);
    return createRefreshToken;
  }

  async findUserTokenByIdAndRefreshToken({
    user_id,
    token_hash,
    jti,
  }: TokenByIdAndRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    const findUserTokenByIdAndRefreshToken = this.refreshTokenItems.find(
      (item) =>
        item.userId === user_id &&
        item.token_hash === token_hash &&
        item.jti === jti &&
        !item.revoked_at,
    );

    if (!findUserTokenByIdAndRefreshToken) {
      return null;
    }

    return findUserTokenByIdAndRefreshToken;
  }

  async deleteUserRefreshTokenById(refreshTokenId: string): Promise<void> {
    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => item.id !== refreshTokenId,
    );
  }

  async rotateUserRefreshToken({
    user_id,
    current_jti,
    current_token_hash,
    replacement,
    grace_ms,
  }: RotateUserRefreshTokenProps): Promise<RefreshRotation> {
    const now = new Date();

    const presented = this.refreshTokenItems.find(
      (item) =>
        item.userId === user_id &&
        item.jti === current_jti &&
        item.token_hash === current_token_hash,
    );

    if (!presented) return { outcome: "unknown" };

    if (!presented.revoked_at && presented.expires_in > now) {
      presented.revoked_at = now;
      presented.replaced_by_jti = replacement.jti;

      return {
        outcome: "rotated",
        token: await this.createUserRefreshToken(replacement),
      };
    }

    // Never spent, or lapsed: an ended session, not a replay (see the real
    // repository).
    if (!presented.revoked_at || presented.expires_in <= now) {
      return { outcome: "unknown" };
    }

    const spentMomentsAgo =
      Boolean(presented.revoked_at) &&
      Boolean(presented.replaced_by_jti) &&
      presented.expires_in > now &&
      now.getTime() - (presented.revoked_at as Date).getTime() < grace_ms;

    if (!spentMomentsAgo) return { outcome: "reused" };

    // A bounded number of siblings per spent token (see the real
    // repository). Checked and counted before any await, so two calls cannot
    // both take the last one.
    if ((presented.grace_siblings ?? 0) >= REFRESH_GRACE_MAX_SIBLINGS) {
      return { outcome: "reused" };
    }

    presented.grace_siblings = (presented.grace_siblings ?? 0) + 1;

    return {
      outcome: "raced",
      token: await this.createUserRefreshToken(replacement),
    };
  }

  async hasActiveRefreshTokenFamily(
    userId: string,
    familyId: string,
  ): Promise<boolean> {
    return this.refreshTokenItems.some(
      (item) =>
        item.userId === userId &&
        item.family_id === familyId &&
        !item.revoked_at &&
        item.expires_in > new Date(),
    );
  }

  async revokeUserRefreshTokenFamily(familyId: string): Promise<void> {
    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => item.family_id !== familyId,
    );
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => item.userId !== userId,
    );
  }

  async listUserDeviceSessions(
    userId: string,
    now = new Date(),
  ): Promise<UserDeviceSession[]> {
    return groupDeviceSessions(
      this.refreshTokenItems
        .filter(
          (item) =>
            item.userId === userId &&
            Boolean(item.device_id) &&
            !item.revoked_at &&
            item.expires_in > now,
        )
        .map((item) => ({
          device_id: item.device_id ?? null,
          family_id: item.family_id,
          created_at: item.created_at ?? new Date(0),
          expires_in: item.expires_in,
        })),
    );
  }

  async findLoginsSignedInOnDevice(
    userIds: string[],
    deviceId: string,
    now = new Date(),
  ): Promise<string[]> {
    return [
      ...new Set(
        this.refreshTokenItems
          .filter(
            (item) =>
              userIds.includes(item.userId) &&
              item.device_id === deviceId &&
              !item.revoked_at &&
              item.expires_in > now,
          )
          .map((item) => item.userId),
      ),
    ];
  }

  /** No push devices in this fake: the real one is proven against Postgres. */
  async revokeUserDeviceSessions(
    userId: string,
    deviceHash: string,
  ): Promise<string[]> {
    const families = [
      ...new Set(
        this.refreshTokenItems
          .filter(
            (item) =>
              item.userId === userId &&
              Boolean(item.device_id) &&
              hashDeviceId(item.device_id!) === deviceHash,
          )
          .map((item) => item.family_id),
      ),
    ];

    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => !(item.userId === userId && families.includes(item.family_id)),
    );

    return families;
  }

  async listUserSessions(
    userId: string,
    now = new Date(),
  ): Promise<UserOwnSession[]> {
    return groupOwnSessions(
      this.refreshTokenItems
        .filter(
          (item) =>
            item.userId === userId && !item.revoked_at && item.expires_in > now,
        )
        .map((item) => ({
          family_id: item.family_id,
          device_id: item.device_id ?? null,
          created_at: item.created_at ?? new Date(0),
          expires_in: item.expires_in,
        })),
      new Set(
        this.pushDeviceTokens
          .filter((row) => row.userId === userId && row.session_family_id)
          .map((row) => row.session_family_id as string),
      ),
    );
  }

  async findSessionFamily(
    userId: string,
    familyId: string,
    now = new Date(),
  ): Promise<UserSessionFamily | null> {
    return sessionFamilyOf(
      familyId,
      this.refreshTokenItems
        .filter((item) => item.userId === userId && item.family_id === familyId)
        .map((item) => ({
          device_id: item.device_id ?? null,
          created_at: item.created_at ?? new Date(0),
          revoked_at: item.revoked_at ?? null,
          expires_in: item.expires_in,
        })),
      now,
    );
  }

  async revokeUserSession(
    userId: string,
    familyId: string,
  ): Promise<{ ended: boolean; deviceId: string | null }> {
    const now = new Date();
    const rows = this.refreshTokenItems.filter(
      (item) => item.userId === userId && item.family_id === familyId,
    );

    // Only a live session ends (see the real repository).
    if (!rows.some((item) => !item.revoked_at && item.expires_in > now)) {
      return { ended: false, deviceId: null };
    }

    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => !(item.userId === userId && item.family_id === familyId),
    );
    this.pushDeviceTokens = this.pushDeviceTokens.filter(
      (row) => !(row.userId === userId && row.session_family_id === familyId),
    );

    return {
      ended: true,
      deviceId: rows.find((item) => item.device_id)?.device_id ?? null,
    };
  }

  /**
   * The Prisma one's semantics without its batches: oldest expired first, at
   * most `maxRows`, nothing once the deadline passed, and `stoppedEarly`
   * whenever an expired row is left.
   */
  async deleteExpiredUserRefreshTokens(
    now = new Date(),
    {
      maxRows = MAX_EXPIRED_REFRESH_TOKENS_PER_RUN,
      deadline = Number.POSITIVE_INFINITY,
    }: RefreshTokenPurgeLimits = {},
  ): Promise<RefreshTokenPurgeResult> {
    const expired = this.refreshTokenItems
      .filter((item) => item.expires_in < now)
      .sort((a, b) => a.expires_in.getTime() - b.expires_in.getTime());

    const take = Date.now() >= deadline ? 0 : Math.min(maxRows, expired.length);
    const gone = new Set(expired.slice(0, take));

    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => !gone.has(item),
    );

    return { deleted: take, stoppedEarly: expired.length > take };
  }

  /** No push devices in this fake: the real one is proven against Postgres. */
  async deleteOrphanPushTokens(): Promise<number> {
    return 0;
  }

  async createTwoFactorToken({
    email,
    expires,
    token,
  }: CreateTwoFactorToken): Promise<TwoFactor> {
    const existing = this.twoFactorTokens.find((item) => item.email === email);

    if (existing) {
      existing.token = token;
      existing.expires = expires;

      // A NEW code starts from zero; otherwise it inherits the previous
      // code's count and locks out the legitimate user.
      existing.attempts = 0;

      return existing;
    }

    const twoFactorToken: TwoFactor = {
      id: uuidV7(),
      email,
      token,
      expires,
      attempts: 0,
    };

    this.twoFactorTokens.push(twoFactorToken);
    return twoFactorToken;
  }

  async findTwoFactorTokenByEmail(email: string): Promise<TwoFactor | null> {
    const findTwoFactorTokenByEmail = this.twoFactorTokens.find(
      (item) => item.email === email,
    );

    if (!findTwoFactorTokenByEmail) {
      return null;
    }

    return findTwoFactorTokenByEmail;
  }

  /**
   * Mirrors the real precondition, including losing the race.
   *
   * A fake that always returns true would make every test agree with a
   * repository that can answer false, which is the whole point of the method.
   */
  async consumeTwoFactorToken(twoFactorId: string): Promise<boolean> {
    const before = this.twoFactorTokens.length;

    this.twoFactorTokens = this.twoFactorTokens.filter(
      (item) => item.id !== twoFactorId,
    );

    return this.twoFactorTokens.length < before;
  }

  async deleteTwoFactorToken(twoFactorId: string): Promise<void> {
    this.twoFactorTokens = this.twoFactorTokens.filter(
      (item) => item.id !== twoFactorId,
    );
  }

  async countTwoFactorAttempt(twoFactorId: string): Promise<number> {
    const token = this.twoFactorTokens.find((item) => item.id === twoFactorId);

    if (!token) return 0;

    // The count lives on the row, as in the database: a twin returning a
    // number without storing it would pass the limit test with it broken.
    token.attempts += 1;

    return token.attempts;
  }

  async createTwoFactorConfirmation(
    userId: string,
  ): Promise<TwoFactorConfirmation> {
    const twoFactorConfirmation: TwoFactorConfirmation = {
      id: uuidV7(),
      userId,
    };

    this.twoFactorConfirmationTokens.push(twoFactorConfirmation);
    return twoFactorConfirmation;
  }

  async findTwoFactorConfirmationByUserId(
    token: string,
  ): Promise<TwoFactorConfirmation | null> {
    const findUserTwoFactorConfirmationByUserId =
      this.twoFactorConfirmationTokens.find((item) => item.userId === token);

    if (!findUserTwoFactorConfirmationByUserId) {
      return null;
    }

    return findUserTwoFactorConfirmationByUserId;
  }

  async deleteTwoFactorConfirmation(
    twoFactorConfirmationId: string,
  ): Promise<void> {
    this.twoFactorConfirmationTokens = this.twoFactorConfirmationTokens.filter(
      (item) => item.id !== twoFactorConfirmationId,
    );
  }

  async createForgotPasswordVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    // Hashed like the real repository: a fake that kept the raw token would
    // let a use case build its link from the returned row and still pass.
    const tokenHash = hashSingleUseToken(token);

    const existing = this.forgotPasswordVerificationTokens.find(
      (item) => item.email === email,
    );

    if (existing) {
      existing.token = tokenHash;
      existing.expires = expires;
      return existing;
    }

    const verificationToken: VerificationToken = {
      id: uuidV7(),
      email,
      token: tokenHash,
      expires,
    };

    this.forgotPasswordVerificationTokens.push(verificationToken);
    return verificationToken;
  }

  async findForgotPasswordVerificationTokenByEmail(
    email: string,
  ): Promise<VerificationToken | null> {
    const token = this.forgotPasswordVerificationTokens.find(
      (item) => item.email === email,
    );

    if (!token) {
      return null;
    }

    return token;
  }

  async findForgotPasswordVerificationTokenByToken(
    token: string,
  ): Promise<VerificationToken | null> {
    const tokenHash = hashSingleUseToken(token);

    const verificationToken = this.forgotPasswordVerificationTokens.find(
      (item) => item.token === tokenHash,
    );

    if (!verificationToken) {
      return null;
    }

    return verificationToken;
  }

  /**
   * Mirrors the real precondition, including losing the race.
   *
   * A fake that always returns true would make every test agree with a
   * repository that can answer false, which is the whole point of the method.
   */
  async consumeForgotPasswordVerificationToken(
    tokenId: string,
  ): Promise<boolean> {
    const before = this.forgotPasswordVerificationTokens.length;

    this.forgotPasswordVerificationTokens =
      this.forgotPasswordVerificationTokens.filter(
        (item) => item.id !== tokenId,
      );

    return this.forgotPasswordVerificationTokens.length < before;
  }

  async deleteForgotPasswordVerificationToken(tokenId: string): Promise<void> {
    this.forgotPasswordVerificationTokens =
      this.forgotPasswordVerificationTokens.filter(
        (item) => item.id !== tokenId,
      );
  }

  async createEmailVerificationToken({
    email,
    token,
    expires,
  }: CreateVerificationToken): Promise<VerificationToken> {
    const tokenHash = hashSingleUseToken(token);

    const existing = this.emailVerificationTokens.find(
      (item) => item.email === email,
    );

    if (existing) {
      existing.token = tokenHash;
      existing.expires = expires;
      return existing;
    }

    const verificationToken: VerificationToken = {
      id: uuidV7(),
      email,
      token: tokenHash,
      expires,
    };

    this.emailVerificationTokens.push(verificationToken);
    return verificationToken;
  }

  async findEmailVerificationTokenByEmail(
    email: string,
  ): Promise<VerificationToken | null> {
    const token = this.emailVerificationTokens.find(
      (item) => item.email === email,
    );

    if (!token) {
      return null;
    }

    return token;
  }

  async findEmailVerificationTokenByToken(
    token: string,
  ): Promise<VerificationToken | null> {
    const tokenHash = hashSingleUseToken(token);

    const verificationToken = this.emailVerificationTokens.find(
      (item) => item.token === tokenHash,
    );

    if (!verificationToken) {
      return null;
    }

    return verificationToken;
  }

  /**
   * Mirrors the real precondition, including losing the race.
   *
   * A fake that always returns true would make every test agree with a
   * repository that can answer false, which is the whole point of the method.
   */
  async consumeEmailVerificationToken(tokenId: string): Promise<boolean> {
    const before = this.emailVerificationTokens.length;

    this.emailVerificationTokens = this.emailVerificationTokens.filter(
      (item) => item.id !== tokenId,
    );

    return this.emailVerificationTokens.length < before;
  }

  async deleteEmailVerificationToken(tokenId: string): Promise<void> {
    this.emailVerificationTokens = this.emailVerificationTokens.filter(
      (item) => item.id !== tokenId,
    );
  }
}

export { InMemoryUserTokensRepository };
