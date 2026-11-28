import type { BusinessSettingsValues } from "@/shared/business/business-settings";

/** A business_settings row (plan of 02/11/2026, M1). */
interface BusinessSettings extends BusinessSettingsValues {
  id: string;
  businessId: string;

  /** Who saved last; null once that user is removed. */
  updatedById: string | null;

  created_at: Date;
  updated_at: Date;
}

/** What a save writes: the fields given, and who saved. */
interface SaveBusinessSettingsProps extends Partial<BusinessSettingsValues> {
  businessId: string;
  updatedById: string;
}

export type { BusinessSettings, SaveBusinessSettingsProps };
