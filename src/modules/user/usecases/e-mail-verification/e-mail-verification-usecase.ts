import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { InvalidTokenError } from "../errors/invalid-token-error";
import { ExpiredTokenError } from "../errors/expired-token-error";

import { AppError } from "@/shared/errors/AppError";
import { MissingTokenError } from "../errors/missing-token-error";

@injectable()
class EmailVerificationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(token: string): Promise<void> {
    if (!token) {
      throw new MissingTokenError();
    }

    const userEmailVerificationToken =
      await this.usersTokens.findEmailVerificationTokenByToken(token);

    if (!userEmailVerificationToken) {
      throw new InvalidTokenError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > userEmailVerificationToken.expires) {
      throw new ExpiredTokenError();
    }

    const user = await this.user.findUserByEmail(
      userEmailVerificationToken.email,
    );

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      await Promise.all([
        this.user.updateEmailVerification({
          userId: user.id,
          email_verified: new Date(),
          email: user.email,
        }),
        this.usersTokens.deleteEmailVerificationToken(
          userEmailVerificationToken.id,
        ),
      ]);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar verificar o seu e-mail! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { EmailVerificationUseCase };
