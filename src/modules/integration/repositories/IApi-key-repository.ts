/** What the key list shows: never the token, never its hash. */
interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_minute: number;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

interface CreateApiKeyData {
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string[];
  rate_limit_per_minute: number;
  businessId: string;
}

/** One bucket of the daily usage aggregate, with the key that made it. */
interface ApiUsageRow {
  apiKeyId: string;
  day: Date;
  method: string;
  route: string;
  status_class: number;
  count: bigint;
  apiKey: { id: string; name: string; prefix: string } | null;
}

/** What authenticating a call needs: the hash to compare and the company gates. */
interface ApiKeyCredential {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string[];
  rate_limit_per_minute: number;
  revoked_at: Date | null;
  businessId: string;
  business: { is_active: boolean; timezone: string };
}

interface ListApiUsageProps {
  businessId: string;
  since: Date;
  apiKeyId?: string;
}

/**
 * The API keys of a company and what their systems asked of us (TEST-ARCH-1).
 *
 * Every read and write is scoped by `businessId`: a key of another company is
 * indistinguishable from one that does not exist.
 */
interface IApiKeyRepository {
  /**
   * Issues the key unless the company already holds `maxActive` active ones,
   * in which case nothing is written and null comes back. One company's
   * issues run in single file, so two clicks at the limit cannot both pass.
   */
  createWithinQuota: (
    data: CreateApiKeyData,
    maxActive: number,
  ) => Promise<{ id: string; prefix: string } | null>;

  /** Newest first, revoked ones included (they are the trail). */
  listByBusiness: (businessId: string) => Promise<ApiKeySummary[]>;

  /** True when an ACTIVE key of the company was revoked now. */
  revoke: (id: string, businessId: string, at: Date) => Promise<boolean>;

  /** The company's zone for the usage days (null: no such company). */
  businessTimeZone: (businessId: string) => Promise<string | null>;

  /** Day descending, then route ascending. */
  listUsage: (props: ListApiUsageProps) => Promise<ApiUsageRow[]>;

  /**
   * The key behind a public prefix, revoked or not, with its company's
   * gates; null when no key has that prefix. The caller decides the refusal,
   * so revoked and unknown can answer the same 401.
   */
  findCredentialByPrefix: (prefix: string) => Promise<ApiKeyCredential | null>;

  /** Bookkeeping for "is this key still used?". Unscoped: the id came from the lookup. */
  touchLastUsed: (id: string, at: Date) => Promise<void>;
}

export type {
  ApiKeyCredential,
  ApiKeySummary,
  ApiUsageRow,
  CreateApiKeyData,
  IApiKeyRepository,
  ListApiUsageProps,
};
