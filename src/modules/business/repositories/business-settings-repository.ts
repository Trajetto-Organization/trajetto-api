import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { IBusinessSettingsRepository } from "./IBusiness-settings-repository";
import type {
  BusinessSettings,
  SaveBusinessSettingsProps,
} from "../dtos/business-settings-dto";

class BusinessSettingsRepository implements IBusinessSettingsRepository {
  constructor(private prisma = database) {}

  async findByBusinessId(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BusinessSettings | null> {
    return (tx ?? this.prisma).businessSettings.findUnique({
      where: { businessId },
    });
  }

  async save(
    { businessId, updatedById, ...values }: SaveBusinessSettingsProps,
    tx?: Prisma.TransactionClient,
  ): Promise<BusinessSettings> {
    // Only the fields given: an undefined key keeps the stored value on an
    // update and takes the column default on the first save.
    const given = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as Partial<typeof values>;

    return (tx ?? this.prisma).businessSettings.upsert({
      where: { businessId },
      create: { businessId, updatedById, ...given },
      update: { updatedById, ...given },
    });
  }
}

export { BusinessSettingsRepository };
