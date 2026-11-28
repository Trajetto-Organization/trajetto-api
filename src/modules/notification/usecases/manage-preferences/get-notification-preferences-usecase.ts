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
 * notification that can never arrive would be a lie in switch form, and
 * hiding the row of one that does arrive leaves its e-mail and WhatsApp
 * with no switch at all (the audit of 14/11/2026 found both).
 *
 * - MASTER: ACCOUNT only — the master accounts it creates or edits, its own
 *   account, and the plan of every company (module, fleet size and AI quota
 *   changed by another master). Fines and assignments go to the companies.
 * - BUSINESS_ADMIN: FINES (the broadcast audience), MAINTENANCE, FINANCE and
 *   TASKS (orders, bills and cards assigned to them; the tower's occurrence
 *   requests), and ACCOUNT: the company's plan, a webhook we switched off,
 *   and a driver's login on a new phone or a password created after a QR.
 * - BUSINESS_USER (drivers included): what can be assigned to a person —
 *   orders, bills and cards — and, for an office profile with the delivery
 *   key, the tower's requests (TASKS).
 *
 * SYSTEM stays out for everyone: since 14/11/2026 it carries only events
 * with no channel at all (the activity trail). A mandatory topic still
 * names a category: the bell and the phone cannot be silenced, but its
 * e-mail and WhatsApp follow that row (preference-catalog.test.ts holds
 * every topic with a channel to its audience's rows).
 */
const CATEGORIES_BY_ROLE: Record<string, NotificationCategory[]> = {
  MASTER: [NotificationCategory.ACCOUNT],
  BUSINESS_ADMIN: [
    NotificationCategory.FINES,
    NotificationCategory.MAINTENANCE,
    NotificationCategory.FINANCE,
    NotificationCategory.TASKS,
    NotificationCategory.ACCOUNT,
  ],
  BUSINESS_USER: [
    NotificationCategory.MAINTENANCE,
    NotificationCategory.FINANCE,
    NotificationCategory.TASKS,
  ],
};

/**
 * The preference rows a role sees and may save; an unknown role gets the
 * narrowest catalog, the one of a person who is only ever assigned work.
 */
function preferenceCategoriesFor(role: string): NotificationCategory[] {
  return CATEGORIES_BY_ROLE[role] ?? CATEGORIES_BY_ROLE.BUSINESS_USER;
}

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

    const categories = preferenceCategoriesFor(user.role);

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
  preferenceCategoriesFor,
};
