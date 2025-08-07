import {
  CreateTwoFactorToken,
  CreateUserRefreshTokenProps,
  CreateVerificationToken,
  TokenByIdAndRefreshTokenProps,
  TwoFactor,
  TwoFactorConfirmation,
  UserRefreshTokenProps,
  VerificationToken,
} from "../dtos/user-tokens-dto";

interface IUsersTokensRepository {
  createUserRefreshToken: ({
    refresh_token,
    expires_in,
    userId,
  }: CreateUserRefreshTokenProps) => Promise<UserRefreshTokenProps>;
  findUserTokenByIdAndRefreshToken: ({
    user_id,
    refresh_token,
  }: TokenByIdAndRefreshTokenProps) => Promise<UserRefreshTokenProps | null>;
  deleteUserRefreshTokenById: (refreshTokenId: string) => Promise<void>;
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
