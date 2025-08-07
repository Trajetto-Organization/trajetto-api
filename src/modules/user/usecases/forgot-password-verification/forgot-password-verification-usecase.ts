import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { InvalidTokenError } from "../errors/invalid-token-error";
import { ExpiredTokenError } from "../errors/expired-token-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";

@injectable()
class ForgotPasswordVerificationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(token: string): Promise<void> {
    const userForgotPasswordVerificationToken =
      await this.usersTokens.findForgotPasswordVerificationTokenByToken(token);

    if (!userForgotPasswordVerificationToken) {
      throw new InvalidTokenError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > userForgotPasswordVerificationToken.expires) {
      throw new ExpiredTokenError();
    }

    const user = await this.user.findUserByEmail(
      userForgotPasswordVerificationToken.email,
    );

    if (!user) {
      throw new ResourceNotFoundError();
    }
  }
}

export { ForgotPasswordVerificationUseCase };
