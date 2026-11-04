import type { Prisma } from "@prisma/client";

import type {
  BusinessSettings,
  SaveBusinessSettingsProps,
} from "../dtos/business-settings-dto";

/**
 * The company's own settings (plan of 02/11/2026, M1). One row per company
 * at most, written on the first save; a company without it reads the
 * defaults (settingsOrDefaults). Never cached in memory (multi-replica: a
 * save on one replica is read by the next request on any other).
 */
interface IBusinessSettingsRepository {
  /** The company's row, or null when it never saved. */
  findByBusinessId: (
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<BusinessSettings | null>;

  /**
   * Writes the fields given (absent ones keep their value, or take the
   * default on the first save) and who saved. The caller holds the company
   * row's lock, so two saves serialize and each sees what the other left.
   */
  save: (
    data: SaveBusinessSettingsProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<BusinessSettings>;
}

export type { IBusinessSettingsRepository };
