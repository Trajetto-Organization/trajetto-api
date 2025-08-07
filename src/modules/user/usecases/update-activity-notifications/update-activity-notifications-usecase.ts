import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface UpdateActivityNotificationsProps {
  userId: string;
  activity_notifications_enabled: boolean;
}

@injectable()
class UpdateActivityNotificationsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    activity_notifications_enabled,
  }: UpdateActivityNotificationsProps): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      await this.user.updateActivityNotifications({
        userId,
        activity_notifications_enabled,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar suas notificações de atividade! Por favor, Tente novamente.",
        500,
      );
    }
  }
}

export { UpdateActivityNotificationsUseCase };
