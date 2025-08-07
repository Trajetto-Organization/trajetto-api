import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface UpdateTwoFactorAuthenticationProps {
  userId: string;
}

@injectable()
class UpdateTwoFactorAuthenticationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({ userId }: UpdateTwoFactorAuthenticationProps): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      if (findUser.two_factor_enabled) {
        await this.user.updateTwoFactorAuthentication({
          userId,
          isTwoFactorEnabled: false,
        });

        return;
      }

      await this.user.updateTwoFactorAuthentication({
        userId,
        isTwoFactorEnabled: true,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar sua autenticação de dois fatores! Por favor, Tente novamente.",
        500,
      );
    }
  }
}

export { UpdateTwoFactorAuthenticationUseCase };
