import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { CursorPaginatedNotifications } from "../../dtos/notification-dto";

import { AppError } from "@/shared/errors/AppError";

interface ListUserNotificationsWithCursorRequest {
  userId: string;
  limit?: number;
  includeRead?: boolean;
  cursor?: string;
}

@injectable()
class ListUserNotificationsCursorUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
  ) {}

  async execute({
    userId,
    limit = 20,
    includeRead = true,
    cursor,
  }: ListUserNotificationsWithCursorRequest): Promise<CursorPaginatedNotifications> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const result =
        await this.notificationRepository.listUserNotificationsWithCursor({
          userId,
          limit,
          includeRead,
          cursor,
        });

      return result;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as notificações! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListUserNotificationsCursorUseCase };
