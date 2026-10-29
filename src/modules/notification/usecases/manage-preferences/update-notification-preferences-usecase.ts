import { inject, injectable } from "tsyringe";

import {
  INotificationRepository,
  UpsertPreferenceInput,
} from "../../repositories/INotification-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

@injectable()
class UpdateNotificationPreferencesUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async execute(
    userId: string,
    preferences: UpsertPreferenceInput[],
  ): Promise<void> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    await this.notificationRepository.upsertPreferences(userId, preferences);
  }
}

export { UpdateNotificationPreferencesUseCase };
