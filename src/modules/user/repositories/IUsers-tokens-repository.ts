import {
  CreateTwoFactorToken,
  CreateUserRefreshTokenProps,
  CreateVerificationToken,
  RefreshRotation,
  RotateUserRefreshTokenProps,
  TokenByIdAndRefreshTokenProps,
  TwoFactor,
  TwoFactorConfirmation,
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
  consumeForgotPasswordVerificationToken: (
    tokenId: string,
  ) => Promise<boolean>;
}

export { IUsersTokensRepository };
