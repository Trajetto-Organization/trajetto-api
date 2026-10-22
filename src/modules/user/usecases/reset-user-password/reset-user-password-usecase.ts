import { inject, injectable } from "tsyringe";
import { hashSecret } from "@/shared/security/bcrypt-gate";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { UserInvalidTokenError } from "../errors/user-invalid-token-error";

import { UserExpiredTokenError } from "../errors/user-expired-token-error";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import { sendSecurityEventToUser } from "@/websocket";

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

    const hashedPassword = await hashSecret(password, 10);

    /**
     * The token is spent BEFORE the password changes, and losing means stop.
     *
     * The two writes used to run side by side in a `Promise.all`, which is
     * neither atomic nor ordered: two requests carrying the same token both
     * read it, both found it valid and both set a password — last one wins,
     * silently — and if only the delete failed, the password changed while
     * the reset link stayed live. Spending the token first fails closed: the
     * request that loses the race changes nothing and is told the token is
     * invalid, which by then it is.
     */
    const spent = await this.usersTokens.consumeForgotPasswordVerificationToken(
      userToken.id,
    );

    if (!spent) {
      throw new UserInvalidTokenError();
    }

    try {
      await this.user.updateUserPassword({
        userId: user.id,
        password: hashedPassword,
      });

      sendSecurityEventToUser(user.id, { reason: "password_reset" });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar sua senha! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ResetUserPasswordUseCase };
