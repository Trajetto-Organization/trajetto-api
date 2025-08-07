import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class MarkAllNotificationsAsReadUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
  ) {}

  async execute(userId: string): Promise<void> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      await this.notificationRepository.markAllAsRead(userId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao marcar todas as notificações como lidas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { MarkAllNotificationsAsReadUseCase };
