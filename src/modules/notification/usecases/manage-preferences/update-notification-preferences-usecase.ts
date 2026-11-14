import { inject, injectable } from "tsyringe";

import {
  INotificationRepository,
  UpsertPreferenceInput,
} from "../../repositories/INotification-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { preferenceCategoriesFor } from "./get-notification-preferences-usecase";

/**
 * Saves the rows of the caller's own catalog (preferenceCategoriesFor) and
 * drops the rest in silence (decision D-54): a row outside the role's
 * catalog governs nothing the person receives, so it would only be dead
 * data, and a client built for another catalog — an app from before the
 * administrator gained the ACCOUNT row — must never fail on saving.
 */
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

    const catalog = new Set(preferenceCategoriesFor(user.role));
    const ownRows = preferences.filter((row) => catalog.has(row.category));

    // Nothing of the caller's own: no write at all, and still a 200.
    if (ownRows.length === 0) return;

    await this.notificationRepository.upsertPreferences(userId, ownRows);
  }
}

export { UpdateNotificationPreferencesUseCase };
