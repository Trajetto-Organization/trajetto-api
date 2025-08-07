import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";

import { NotificationNotFoundError } from "../errors/notification-not-found-error";
import { NotificationNotAuthorizedError } from "../errors/notification-not-authorized-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface DeleteNotificationRequest {
  notificationId: string;
  userId: string;
}

@injectable()
class DeleteNotificationUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async execute({
    notificationId,
    userId,
  }: DeleteNotificationRequest): Promise<void> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    const notification =
      await this.notificationRepository.findNotificationById(notificationId);

    if (!notification) {
      throw new NotificationNotFoundError();
    }

    if (notification.userId !== userId) {
      throw new NotificationNotAuthorizedError();
    }

    try {
      await this.notificationRepository.deleteNotification(notificationId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir a notificação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteNotificationUseCase };
