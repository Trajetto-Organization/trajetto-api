import { inject, injectable } from "tsyringe";
import { INotificationRepository } from "../../repositories/INotification-repository";

import { Notification } from "../../dtos/notification-dto";

import { NotificationNotFoundError } from "../errors/notification-not-found-error";
import { NotificationNotAuthorizedError } from "../errors/notification-not-authorized-error";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";

interface MarkNotificationAsReadRequest {
  notificationId: string;
  userId: string;
}

@injectable()
class MarkNotificationAsReadUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async execute({
    notificationId,
    userId,
  }: MarkNotificationAsReadRequest): Promise<Notification> {
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

    if (notification.read) {
      return notification; // It is already marked as read
    }

    try {
      const updatedNotification =
        await this.notificationRepository.markAsRead(notificationId);
      return updatedNotification;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar marcar a notificação como lida!",
        500,
      );
    }
  }
}

export { MarkNotificationAsReadUseCase };
