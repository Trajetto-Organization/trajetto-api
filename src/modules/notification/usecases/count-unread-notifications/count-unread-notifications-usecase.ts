import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CountUnreadNotificationsUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
  ) {}

  async execute(userId: string): Promise<{ count: number }> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const count =
        await this.notificationRepository.countUnreadNotifications(userId);
      return { count };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar contar as notificações não lidas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CountUnreadNotificationsUseCase };
