import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface UpdateEmailNotificationsProps {
  userId: string;
  email_notifications_enabled: boolean;
}

@injectable()
class UpdateEmailNotificationsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    email_notifications_enabled,
  }: UpdateEmailNotificationsProps): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      await this.user.updateEmailNotifications({
        userId,
        email_notifications_enabled,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar suas notificações por e-mail! Por favor, Tente novamente.",
        500,
      );
    }
  }
}

export { UpdateEmailNotificationsUseCase };
