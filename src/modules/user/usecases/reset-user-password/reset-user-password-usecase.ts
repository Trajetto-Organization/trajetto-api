import { inject, injectable } from "tsyringe";
import { hash } from "bcrypt";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { UserInvalidTokenError } from "../errors/user-invalid-token-error";

import { UserExpiredTokenError } from "../errors/user-expired-token-error";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface ResetUserPasswordProps {
  token: string;
  password: string;
}

@injectable()
class ResetUserPasswordUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute({ token, password }: ResetUserPasswordProps): Promise<void> {
    const userToken =
      await this.usersTokens.findForgotPasswordVerificationTokenByToken(token);

    if (!userToken) {
      throw new UserInvalidTokenError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > userToken.expires) {
      throw new UserExpiredTokenError();
    }

    const user = await this.user.findUserByEmail(userToken.email);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    const hashedPassword = await hash(password, 10);

    try {
      await Promise.all([
        this.user.updateUserPassword({
          userId: user.id,
          password: hashedPassword,
        }),
        this.usersTokens.deleteForgotPasswordVerificationToken(userToken.id),
      ]);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar sua senha! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ResetUserPasswordUseCase };
