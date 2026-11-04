import { v7 as uuidV7 } from "uuid";

import { BUSINESS_SETTINGS_DEFAULTS } from "@/shared/business/business-settings";

import type { IBusinessSettingsRepository } from "../IBusiness-settings-repository";
import type {
  BusinessSettings,
  SaveBusinessSettingsProps,
} from "../../dtos/business-settings-dto";

/**
 * The twin of BusinessSettingsRepository: one row per company, the column
 * defaults on the first save, absent fields kept on the next ones. The
 * radius CHECK lives in the database; the use case's schema bounds it first.
 */
class InMemoryBusinessSettingsRepository
  implements IBusinessSettingsRepository
{
  public settings: BusinessSettings[] = [];

  async findByBusinessId(businessId: string): Promise<BusinessSettings | null> {
    const row = this.settings.find((entry) => entry.businessId === businessId);

    return row ? { ...row } : null;
  }

  async save({
    businessId,
    updatedById,
    ...values
  }: SaveBusinessSettingsProps): Promise<BusinessSettings> {
    const given = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as Partial<typeof values>;

    const now = new Date();
    const existing = this.settings.find(
      (entry) => entry.businessId === businessId,
    );

    if (existing) {
      Object.assign(existing, given, { updatedById, updated_at: now });

      return { ...existing };
    }

    const row: BusinessSettings = {
      id: uuidV7(),
      businessId,
      ...BUSINESS_SETTINGS_DEFAULTS,
      ...given,
      updatedById,
      created_at: now,
      updated_at: now,
    };

    this.settings.push(row);

    return { ...row };
  }
}

export { InMemoryBusinessSettingsRepository };
