import {
  CreateTwoFactorToken,
  CreateUserRefreshTokenProps,
  CreateVerificationToken,
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
  ) => Promise<UserRefreshTokenProps | null>;
  hasActiveRefreshTokenFamily: (
    userId: string,
    familyId: string,
  ) => Promise<boolean>;
  revokeUserRefreshTokenFamily: (familyId: string) => Promise<void>;
  revokeAllUserRefreshTokens: (userId: string) => Promise<void>;
  deleteExpiredUserRefreshTokens: (now?: Date) => Promise<number>;
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
   * Conta mais um palpite errado e devolve o total.
   *
   * O incremento é do banco (`increment`), nunca um read-then-write: duas
   * tentativas simultâneas do mesmo código leriam o mesmo valor e gravariam o
   * mesmo, e o contador contaria uma.
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
}

export { IUsersTokensRepository };
