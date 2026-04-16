import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserInvalidTokenError } from "../errors/user-invalid-token-error";
import { UserExpiredTokenError } from "../errors/user-expired-token-error";

import { UserMissingTokenError } from "../errors/user-missing-token-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class EmailVerificationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(token: string): Promise<void> {
    if (!token) {
      throw new UserMissingTokenError();
    }

    const userEmailVerificationToken =
      await this.usersTokens.findEmailVerificationTokenByToken(token);

    if (!userEmailVerificationToken) {
      throw new UserInvalidTokenError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > userEmailVerificationToken.expires) {
      throw new UserExpiredTokenError();
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

      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "update",
        entityId: user.id,
        description: `E-mail verificado com sucesso: ${user.email} | Usuário: ${user.name}`,
        status: "Completo",
        performedBy: user.id,
        businessId: user.businessId ?? null,
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar verificar o seu e-mail! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { EmailVerificationUseCase };
