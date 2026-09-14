import { inject, injectable } from "tsyringe";
import { NotificationCategory } from "@prisma/client";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface CategoryPreferenceView {
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  whatsapp: boolean;

  /** True while the user has never saved this category — legacy defaults. */
  isDefault: boolean;
}

/**
 * Which categories each role can actually receive — showing a toggle for a
 * notification that can never arrive would be a lie in switch form.
 *
 * - MASTER hears about master accounts (ACCOUNT); fines and assignments go
 *   to business people. Campaigns will extend this list when they exist.
 * - BUSINESS_ADMIN is the broadcast audience for fines and can be assigned
 *   orders, bills and cards.
 * - BUSINESS_USER (including drivers) receives assignments only.
 *
 * SYSTEM stays out for everyone: it only carries activity-trail events that
 * never reach a user's channels anyway.
 */
const CATEGORIES_BY_ROLE: Record<string, NotificationCategory[]> = {
  MASTER: [NotificationCategory.ACCOUNT],
  BUSINESS_ADMIN: [
    NotificationCategory.FINES,
    NotificationCategory.MAINTENANCE,
    NotificationCategory.FINANCE,
    NotificationCategory.TASKS,
  ],
  BUSINESS_USER: [
    NotificationCategory.MAINTENANCE,
    NotificationCategory.FINANCE,
    NotificationCategory.TASKS,
  ],
};

@injectable()
class GetNotificationPreferencesUseCase {
  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async execute(userId: string): Promise<CategoryPreferenceView[]> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    const rows = await this.notificationRepository.listPreferences(userId);
    const rowByCategory = new Map(rows.map((row) => [row.category, row]));

    const categories =
      CATEGORIES_BY_ROLE[user.role] ?? CATEGORIES_BY_ROLE.BUSINESS_USER;

    // Same fallback the pipeline applies: without a saved row, the legacy
    // global toggles are the truth — so what this returns is exactly what
    // would happen.
    return categories.map((category) => {
      const row = rowByCategory.get(category);

      if (row) {
        return {
          category,
          inApp: row.inApp,
          email: row.email,
          whatsapp: row.whatsapp,
          isDefault: false,
        };
      }

      return {
        category,
        inApp: user.activity_notifications_enabled ?? true,
        email: user.email_notifications_enabled ?? true,
        whatsapp: user.whatsapp_notifications_enabled ?? false,
        isDefault: true,
      };
    });
  }
}

export {
  GetNotificationPreferencesUseCase,
  CATEGORIES_BY_ROLE,
  CategoryPreferenceView,
};
