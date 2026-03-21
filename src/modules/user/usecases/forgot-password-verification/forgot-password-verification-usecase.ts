import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidTokenError } from "../errors/user-invalid-token-error";
import { UserExpiredTokenError } from "../errors/user-expired-token-error";

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
      throw new UserInvalidTokenError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > userForgotPasswordVerificationToken.expires) {
      throw new UserExpiredTokenError();
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
