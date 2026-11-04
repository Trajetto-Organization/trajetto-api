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
  UserRefreshTokenProps,
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
   * Ends every session of the user bound to this phone — its refresh tokens
   * and the push devices those sessions registered — in one transaction, and
   * returns the sessions (family ids) it ended, for the socket.
   */
  revokeUserDeviceSessions: (
    userId: string,
    deviceId: string,
  ) => Promise<string[]>;
  deleteExpiredUserRefreshTokens: (now?: Date) => Promise<number>;

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

export { IUsersTokensRepository, REFRESH_GRACE_MAX_SIBLINGS };
