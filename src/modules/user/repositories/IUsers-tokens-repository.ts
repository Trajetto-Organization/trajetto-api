import {
  CreateTwoFactorToken,
  CreateUserRefreshTokenProps,
  CreateVerificationToken,
  RefreshRotation,
  RotateUserRefreshTokenProps,
  TokenByIdAndRefreshTokenProps,
  TwoFactor,
  TwoFactorConfirmation,
  UserDeviceSession,
  UserOwnSession,
  UserRefreshTokenProps,
  UserSessionFamily,
  VerificationToken,
} from "../dtos/user-tokens-dto";

interface IUsersTokensRepository {
  createUserRefreshToken: ({
    token_hash,
    expires_in,
    userId,
    jti,
    family_id,
  }: CreateUserRefreshTokenProps) => Promise<UserRefreshTokenProps>;
  findUserTokenByIdAndRefreshToken: ({
    user_id,
    token_hash,
    jti,
  }: TokenByIdAndRefreshTokenProps) => Promise<UserRefreshTokenProps | null>;
  deleteUserRefreshTokenById: (refreshTokenId: string) => Promise<void>;
  rotateUserRefreshToken: (
    props: RotateUserRefreshTokenProps,
  ) => Promise<RefreshRotation>;
  hasActiveRefreshTokenFamily: (
    userId: string,
    familyId: string,
  ) => Promise<boolean>;
  /** Ends one session: its refresh tokens and the push devices it registered. */
  revokeUserRefreshTokenFamily: (familyId: string) => Promise<void>;
  revokeAllUserRefreshTokens: (userId: string) => Promise<void>;

  /**
   * The user's phones with a live session bound to them (plan of 02/11/2026,
   * D7), most recently active first. Sessions without a phone (the web, and
   * mobile sessions opened by e-mail) are not listed.
   */
  listUserDeviceSessions: (
    userId: string,
    now?: Date,
  ) => Promise<UserDeviceSession[]>;

  /**
   * Which of these logins hold a live session bound to this phone: a row
   * neither revoked nor expired whose `device_id` is the phone as stored
   * (session-service normalizeSessionDeviceId). The CPF login asks it before
   * any password is compared, to trust a phone the rollout left out
   * (AuthenticateUserUseCase.executeByCpf). Order is not meaningful.
   */
  findLoginsSignedInOnDevice: (
    userIds: string[],
    deviceId: string,
    now?: Date,
  ) => Promise<string[]>;

  /**
   * Ends every session of the user bound to the phone with this hash
   * (session-service hashDeviceId, what listUserDeviceSessions hands out) —
   * its refresh tokens and the push devices those sessions registered — in
   * one transaction, and returns the sessions (family ids) it ended, for the
   * socket.
   */
  revokeUserDeviceSessions: (
    userId: string,
    deviceHash: string,
  ) => Promise<string[]>;
  /**
   * The person's own sessions (wave 2, "Aparelhos conectados"): every live
   * family of the user, web and app ones included, most recently used first.
   * Never the phone's id.
   */
  listUserSessions: (userId: string, now?: Date) => Promise<UserOwnSession[]>;

  /**
   * The session a request runs in, when it is still live (a row neither
   * revoked nor expired); null otherwise. Internal: carries the phone's id,
   * for re-issuing a phone-bound session.
   */
  findSessionFamily: (
    userId: string,
    familyId: string,
    now?: Date,
  ) => Promise<UserSessionFamily | null>;

  /**
   * Ends one of the user's live sessions — its refresh tokens and the push
   * devices it registered — in one transaction. Scoped by user: another
   * person's session id, or a session already over, ends nothing. Returns
   * whether something ended and, internally, the phone it was bound to.
   */
  revokeUserSession: (
    userId: string,
    familyId: string,
  ) => Promise<{ ended: boolean; deviceId: string | null }>;
  /**
   * Removes the refresh tokens past their expires_in, oldest first and in
   * batches (F1-18), until none is left, `maxRows` or the `deadline`; never
   * a live one. `stoppedEarly` says expired rows are still there, which
   * makes the nightly run partial. A single delete of a day of sessions at
   * the target volume (~1–1.5 M rows) would run into the statement_timeout.
   */
  deleteExpiredUserRefreshTokens: (
    now?: Date,
    limits?: RefreshTokenPurgeLimits,
  ) => Promise<RefreshTokenPurgeResult>;

  /**
   * Unregisters the push devices whose session has no refresh token left —
   * a logout the server never heard of (offline, app killed), once the
   * session has expired and been purged. Returns how many were removed.
   */
  deleteOrphanPushTokens: () => Promise<number>;
  createEmailVerificationToken: ({
    email,
    token,
    expires,
  }: CreateVerificationToken) => Promise<VerificationToken>;
  findEmailVerificationTokenByEmail: (
    email: string,
  ) => Promise<VerificationToken | null>;
  findEmailVerificationTokenByToken: (
    token: string,
  ) => Promise<VerificationToken | null>;
  deleteEmailVerificationToken: (tokenId: string) => Promise<void>;
  /**
   * Spends the token, and says whether THIS caller was the one who spent it.
   *
   * A single-use token was being read, checked and only then deleted. Two
   * requests carrying the same token both read it, both passed every check
   * and both went on to act — so "single use" held only when nobody tried
   * twice at once. The delete is the precondition now: it either removes the
   * row and returns true, or finds nothing and returns false because someone
   * else got there first.
   */
  consumeEmailVerificationToken: (tokenId: string) => Promise<boolean>;
  createTwoFactorToken: ({
    email,
    expires,
    token,
  }: CreateTwoFactorToken) => Promise<TwoFactor>;
  findTwoFactorTokenByEmail: (email: string) => Promise<TwoFactor | null>;
  findTwoFactorConfirmationByUserId: (
    token: string,
  ) => Promise<TwoFactorConfirmation | null>;
  createTwoFactorConfirmation: (
    userId: string,
  ) => Promise<TwoFactorConfirmation>;
  deleteTwoFactorConfirmation: (
    twoFactorConfirmationId: string,
  ) => Promise<void>;
  deleteTwoFactorToken: (twoFactorId: string) => Promise<void>;
  /**
   * Spends the token, and says whether THIS caller was the one who spent it.
   *
   * A single-use token was being read, checked and only then deleted. Two
   * requests carrying the same token both read it, both passed every check
   * and both went on to act — so "single use" held only when nobody tried
   * twice at once. The delete is the precondition now: it either removes the
   * row and returns true, or finds nothing and returns false because someone
   * else got there first.
   */
  consumeTwoFactorToken: (twoFactorId: string) => Promise<boolean>;

  /**
   * Counts one more wrong guess and returns the total. The database
   * increments (`increment`), never a read-then-write: two concurrent guesses
   * would read the same value and count once.
   */
  countTwoFactorAttempt: (twoFactorId: string) => Promise<number>;
  createForgotPasswordVerificationToken: ({
    email,
    token,
    expires,
  }: CreateVerificationToken) => Promise<VerificationToken>;
  findForgotPasswordVerificationTokenByEmail: (
    email: string,
  ) => Promise<VerificationToken | null>;
  findForgotPasswordVerificationTokenByToken: (
    token: string,
  ) => Promise<VerificationToken | null>;
  deleteForgotPasswordVerificationToken: (tokenId: string) => Promise<void>;
  /**
   * Spends the token, and says whether THIS caller was the one who spent it.
   *
   * A single-use token was being read, checked and only then deleted. Two
   * requests carrying the same token both read it, both passed every check
   * and both went on to act — so "single use" held only when nobody tried
   * twice at once. The delete is the precondition now: it either removes the
   * row and returns true, or finds nothing and returns false because someone
   * else got there first.
   */
  consumeForgotPasswordVerificationToken: (tokenId: string) => Promise<boolean>;
}

/**
 * How many siblings one spent refresh token may mint within the grace window
 * (the session racing itself: tabs, one page's parallel renewals, a retried
 * answer); the next presentation is reuse. Both repositories enforce it.
 */
const REFRESH_GRACE_MAX_SIBLINGS = 3;

interface RefreshTokenPurgeLimits {
  /** Ceiling on rows removed in one call. */
  maxRows?: number;

  /** Epoch millis after which no new batch starts. */
  deadline?: number;
}

interface RefreshTokenPurgeResult {
  deleted: number;

  /** Expired rows are still there: the ceiling or the deadline stopped it. */
  stoppedEarly: boolean;
}

/**
 * Protection, not the plan: a night at the target volume is ~1–1.5 M
 * expired rows, and the run's budget is the bound that bites first.
 */
const MAX_EXPIRED_REFRESH_TOKENS_PER_RUN = 10_000_000;

export {
  IUsersTokensRepository,
  MAX_EXPIRED_REFRESH_TOKENS_PER_RUN,
  REFRESH_GRACE_MAX_SIBLINGS,
};
export type { RefreshTokenPurgeLimits, RefreshTokenPurgeResult };
