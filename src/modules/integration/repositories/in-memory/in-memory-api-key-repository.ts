import { randomUUID } from "node:crypto";

import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";

import type {
  ApiKeyCredential,
  ApiKeySummary,
  ApiUsageRow,
  CreateApiKeyData,
  IApiKeyRepository,
  ListApiUsageProps,
} from "../IApi-key-repository";

interface InMemoryApiKey extends ApiKeySummary {
  token_hash: string;
  businessId: string;
  updated_at: Date;
}

interface InMemoryUsageRow extends Omit<ApiUsageRow, "apiKey"> {
  businessId: string;
}

/**
 * The twin of ApiKeyRepository, with the same rules the database enforces:
 * `prefix` is unique (P2002 like Prisma), the quota counts only active keys,
 * every read is scoped by company, and the orders are the same.
 */
class InMemoryApiKeyRepository implements IApiKeyRepository {
  constructor(
    public keys: InMemoryApiKey[] = [],
    public usage: InMemoryUsageRow[] = [],
    public timeZones: Map<string, string> = new Map(),
    /** Companies switched off (Business.is_active false); all others are active. */
    public inactiveBusinesses: Set<string> = new Set(),
  ) {}

  async createWithinQuota(
    data: CreateApiKeyData,
    maxActive: number,
  ): Promise<{ id: string; prefix: string } | null> {
    const active = this.keys.filter(
      (key) => key.businessId === data.businessId && key.revoked_at === null,
    ).length;

    if (active >= maxActive) return null;

    if (this.keys.some((key) => key.prefix === data.prefix)) {
      throw Object.assign(new Error("Unique constraint failed on prefix"), {
        code: "P2002",
        meta: { target: ["prefix"] },
      });
    }

    const now = new Date();
    const key: InMemoryApiKey = {
      id: randomUUID(),
      name: data.name,
      prefix: data.prefix,
      token_hash: data.token_hash,
      scopes: [...data.scopes],
      rate_limit_per_minute: data.rate_limit_per_minute,
      last_used_at: null,
      revoked_at: null,
      businessId: data.businessId,
      created_at: now,
      updated_at: now,
    };

    this.keys.push(key);

    return { id: key.id, prefix: key.prefix };
  }

  async listByBusiness(businessId: string): Promise<ApiKeySummary[]> {
    return this.keys
      .filter((key) => key.businessId === businessId)
      .sort(
        (left, right) => right.created_at.getTime() - left.created_at.getTime(),
      )
      .map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: [...key.scopes],
        rate_limit_per_minute: key.rate_limit_per_minute,
        last_used_at: key.last_used_at,
        revoked_at: key.revoked_at,
        created_at: key.created_at,
      }));
  }

  async revoke(id: string, businessId: string, at: Date): Promise<boolean> {
    const key = this.keys.find(
      (candidate) =>
        candidate.id === id &&
        candidate.businessId === businessId &&
        candidate.revoked_at === null,
    );

    if (!key) return false;

    key.revoked_at = at;
    key.updated_at = at;

    return true;
  }

  async businessTimeZone(businessId: string): Promise<string | null> {
    return this.timeZones.get(businessId) ?? null;
  }

  async listUsage({
    businessId,
    since,
    apiKeyId,
  }: ListApiUsageProps): Promise<ApiUsageRow[]> {
    return this.usage
      .filter(
        (row) =>
          row.businessId === businessId &&
          row.day.getTime() >= since.getTime() &&
          (!apiKeyId || row.apiKeyId === apiKeyId),
      )
      .sort(
        (left, right) =>
          right.day.getTime() - left.day.getTime() ||
          (left.route < right.route ? -1 : left.route > right.route ? 1 : 0),
      )
      .map((row) => {
        const key = this.keys.find(
          (candidate) => candidate.id === row.apiKeyId,
        );

        return {
          apiKeyId: row.apiKeyId,
          day: row.day,
          method: row.method,
          route: row.route,
          status_class: row.status_class,
          count: row.count,
          apiKey: key
            ? { id: key.id, name: key.name, prefix: key.prefix }
            : null,
        };
      });
  }

  async findCredentialByPrefix(
    prefix: string,
  ): Promise<ApiKeyCredential | null> {
    const key = this.keys.find((candidate) => candidate.prefix === prefix);

    if (!key) return null;

    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      token_hash: key.token_hash,
      scopes: [...key.scopes],
      rate_limit_per_minute: key.rate_limit_per_minute,
      revoked_at: key.revoked_at,
      businessId: key.businessId,
      business: {
        is_active: !this.inactiveBusinesses.has(key.businessId),
        timezone:
          this.timeZones.get(key.businessId) ?? DEFAULT_BUSINESS_TIMEZONE,
      },
    };
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    const key = this.keys.find((candidate) => candidate.id === id);

    // Prisma's update raises P2025 for a missing row; so does the twin.
    if (!key) throw recordNotFound("update");

    key.last_used_at = at;
    key.updated_at = at;
  }
}

export { InMemoryApiKeyRepository };
export type { InMemoryApiKey, InMemoryUsageRow };
