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
  RotateUserRefreshTokenProps,
} from "../../dtos/user-tokens-dto";

class InMemoryUserTokensRepository implements IUsersTokensRepository {
  public refreshTokenItems: UserRefreshTokenProps[] = [];
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
  }: RotateUserRefreshTokenProps): Promise<UserRefreshTokenProps | null> {
    const current = this.refreshTokenItems.find(
      (item) =>
        item.userId === user_id &&
        item.jti === current_jti &&
        item.token_hash === current_token_hash &&
        !item.revoked_at &&
        item.expires_in > new Date(),
    );

    if (!current) return null;

    current.revoked_at = new Date();
    current.replaced_by_jti = replacement.jti;
    return this.createUserRefreshToken(replacement);
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

  async deleteExpiredUserRefreshTokens(now = new Date()): Promise<number> {
    const previousCount = this.refreshTokenItems.length;
    this.refreshTokenItems = this.refreshTokenItems.filter(
      (item) => item.expires_in >= now,
    );

    return previousCount - this.refreshTokenItems.length;
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

      // Um código NOVO começa do zero. Sem isto, pedir outro código herdaria a
      // contagem do anterior e o usuário legítimo ficaria travado.
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

  async deleteTwoFactorToken(twoFactorId: string): Promise<void> {
    this.twoFactorTokens = this.twoFactorTokens.filter(
      (item) => item.id !== twoFactorId,
    );
  }

  async countTwoFactorAttempt(twoFactorId: string): Promise<number> {
    const token = this.twoFactorTokens.find((item) => item.id === twoFactorId);

    if (!token) return 0;

    // O contador de verdade fica na linha, como no banco: um fake que
    // devolvesse um número sem guardá-lo deixaria o teste do limite passar
    // com o limite quebrado.
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
