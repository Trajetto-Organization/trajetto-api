import { v7 as uuidV7 } from "uuid";
import { IUsersTokensRepository } from "../IUsers-tokens-repository";

import {
  CreateUserRefreshTokenProps,
  TokenByIdAndRefreshTokenProps,
  UserRefreshTokenProps,
  CreateVerificationToken,
  VerificationToken,
  TwoFactor,
  TwoFactorConfirmation,
  CreateTwoFactorToken,
} from "../../dtos/user-tokens-dto";

class InMemoryUserTokensRepository implements IUsersTokensRepository {
  public refreshTokenItems: UserRefreshTokenProps[] = [];
  public forgotPasswordVerificationTokens: VerificationToken[] = [];

  public emailVerificationTokens: VerificationToken[] = [];
  public twoFactorTokens: TwoFactor[] = [];

  public twoFactorConfirmationTokens: TwoFactorConfirmation[] = [];

  async createUserRefreshToken({
    refresh_token,
    expires_in,
    userId,
  }: CreateUserRefreshTokenProps): Promise<UserRefreshTokenProps> {
    const createRefreshToken: UserRefreshTokenProps = {
      id: uuidV7(),
      refresh_token,
      expires_in,
      userId,
    };

    this.refreshTokenItems.push(createRefreshToken);
    return createRefreshToken;
  }

  async findUserTokenByIdAndRefreshToken({
    user_id,
    refresh_token,
  }: TokenByIdAndRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    const findUserTokenByIdAndRefreshToken = this.refreshTokenItems.find(
      (item) => item.userId === user_id && item.refresh_token === refresh_token,
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

  async createTwoFactorToken({
    email,
    expires,
    token,
  }: CreateTwoFactorToken): Promise<TwoFactor> {
    const existing = this.twoFactorTokens.find((item) => item.email === email);

    if (existing) {
      existing.token = token;
      existing.expires = expires;
      return existing;
    }

    const twoFactorToken: TwoFactor = {
      id: uuidV7(),
      email,
      token,
      expires,
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

  async deleteTwoFactorToken(twoFactorId: string): Promise<void> {
    this.twoFactorTokens = this.twoFactorTokens.filter(
      (item) => item.id !== twoFactorId,
    );
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
    const existing = this.forgotPasswordVerificationTokens.find(
      (item) => item.email === email,
    );

    if (existing) {
      existing.token = token;
      existing.expires = expires;
      return existing;
    }

    const verificationToken: VerificationToken = {
      id: uuidV7(),
      email,
      token,
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
    const verificationToken = this.forgotPasswordVerificationTokens.find(
      (item) => item.token === token,
    );

    if (!verificationToken) {
      return null;
    }

    return verificationToken;
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
    const existing = this.emailVerificationTokens.find(
      (item) => item.email === email,
    );

    if (existing) {
      existing.token = token;
      existing.expires = expires;
      return existing;
    }

    const verificationToken: VerificationToken = {
      id: uuidV7(),
      email,
      token,
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
    const verificationToken = this.emailVerificationTokens.find(
      (item) => item.token === token,
    );

    if (!verificationToken) {
      return null;
    }

    return verificationToken;
  }

  async deleteEmailVerificationToken(tokenId: string): Promise<void> {
    this.emailVerificationTokens = this.emailVerificationTokens.filter(
      (item) => item.id !== tokenId,
    );
  }
}

export { InMemoryUserTokensRepository };
