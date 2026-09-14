import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

@injectable()
class MarkAllNotificationsReadUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  /** Returns how many notifications were actually flipped. */
  async execute(userId: string): Promise<number> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    return this.notificationRepository.markAllAsRead(userId);
  }
}

export { MarkAllNotificationsReadUseCase };
