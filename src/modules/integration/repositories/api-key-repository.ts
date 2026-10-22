import database from "@/../infra/database";

import type {
  ApiKeyCredential,
  ApiKeySummary,
  ApiUsageRow,
  CreateApiKeyData,
  IApiKeyRepository,
  ListApiUsageProps,
} from "./IApi-key-repository";

class ApiKeyRepository implements IApiKeyRepository {
  constructor(private prisma = database) {}

  async createWithinQuota(
    data: CreateApiKeyData,
    maxActive: number,
  ): Promise<{ id: string; prefix: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      // One company's issues in single file, so two clicks at the limit
      // cannot both pass the count. An advisory lock and not FOR UPDATE on
      // the business row: that would also block every foreign-key check
      // against the row — each delivery the company writes — while held.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`api-key-quota:${data.businessId}`}, 0))`;

      // Revoked keys do not count: they are kept for the trail, not in use.
      const active = await tx.apiKey.count({
        where: { businessId: data.businessId, revoked_at: null },
      });

      if (active >= maxActive) return null;

      return tx.apiKey.create({
        data,
        select: { id: true, prefix: true },
      });
    });
  }

  async listByBusiness(businessId: string): Promise<ApiKeySummary[]> {
    return this.prisma.apiKey.findMany({
      where: { businessId },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        rate_limit_per_minute: true,
        last_used_at: true,
        revoked_at: true,
        created_at: true,
      },
    });
  }

  async revoke(id: string, businessId: string, at: Date): Promise<boolean> {
    // Revoked, not deleted: a key that made calls is part of the answer to
    // what happened, and deleting it would take the trail with it.
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id, businessId, revoked_at: null },
      data: { revoked_at: at },
    });

    return count > 0;
  }

  async businessTimeZone(businessId: string): Promise<string | null> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });

    return business?.timezone ?? null;
  }

  async listUsage({
    businessId,
    since,
    apiKeyId,
  }: ListApiUsageProps): Promise<ApiUsageRow[]> {
    return this.prisma.apiKeyUsageDaily.findMany({
      where: {
        businessId,
        day: { gte: since },
        ...(apiKeyId && { apiKeyId }),
      },
      select: {
        apiKeyId: true,
        day: true,
        method: true,
        route: true,
        status_class: true,
        count: true,
        apiKey: { select: { id: true, name: true, prefix: true } },
      },
      orderBy: [{ day: "desc" }, { route: "asc" }],
    });
  }

  async findCredentialByPrefix(
    prefix: string,
  ): Promise<ApiKeyCredential | null> {
    return this.prisma.apiKey.findUnique({
      where: { prefix },
      select: {
        id: true,
        name: true,
        prefix: true,
        token_hash: true,
        scopes: true,
        rate_limit_per_minute: true,
        revoked_at: true,
        businessId: true,
        business: { select: { is_active: true, timezone: true } },
      },
    });
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id },
      data: { last_used_at: at },
    });
  }
}

export { ApiKeyRepository };
