import type { Prisma } from "@prisma/client";

/** What the endpoint list shows: never the secret, never the headers. */
interface WebhookEndpointSummary {
  id: string;
  name: string;
  url: string;
  topics: string[];
  is_active: boolean;
  disabled_at: Date | null;
  consecutive_failures: number;
  created_at: Date;
}

/** Headers arrive sealed (see secret-box); null clears them. */
type SealedHeaders = Prisma.InputJsonValue | null;

interface CreateWebhookEndpointData {
  name: string;
  url: string;
  /** Sealed. */
  secret: string;
  topics: string[];
  headers: SealedHeaders;
  is_active: boolean;
}

interface UpdateWebhookEndpointData {
  name: string;
  url: string;
  topics: string[];
  /** Undefined keeps what is stored; null clears. */
  headers?: SealedHeaders;
  is_active: boolean;
}

interface RotateWebhookSecretData {
  /** The new secret, sealed. */
  secret: string;
  /** How the current secret is kept as the previous one (sealed as stored). */
  previousOf: (current: string) => string;
  previousExpiresAt: Date;
}

/**
 * The webhook endpoints of a company (TEST-ARCH-1). Every read and write is
 * scoped by `businessId`: another company's endpoint is "not found".
 */
interface IWebhookEndpointRepository {
  /**
   * Registers the endpoint unless the company already has `max` of them
   * (paused ones count), in which case nothing is written and null comes
   * back. One company's creates run in single file.
   */
  createWithinQuota: (
    businessId: string,
    data: CreateWebhookEndpointData,
    max: number,
  ) => Promise<{ id: string } | null>;

  /**
   * Saves the edit and, with it, clears our breaker (disabled_at, failure
   * streak): editing an endpoint is somebody saying they fixed it.
   */
  update: (
    id: string,
    businessId: string,
    data: UpdateWebhookEndpointData,
  ) => Promise<boolean>;

  find: (
    id: string,
    businessId: string,
  ) => Promise<{ id: string; name: string; is_active: boolean } | null>;

  /** Clears the breaker of a switched-off endpoint; false when it was not off. */
  resetBreaker: (id: string, businessId: string) => Promise<boolean>;

  /** New secret, the current one kept as previous; locked against a twin rotation. */
  rotateSecret: (
    id: string,
    businessId: string,
    data: RotateWebhookSecretData,
  ) => Promise<boolean>;

  /** Newest first. */
  listByBusiness: (businessId: string) => Promise<WebhookEndpointSummary[]>;

  delete: (id: string, businessId: string) => Promise<boolean>;
}

export type {
  CreateWebhookEndpointData,
  IWebhookEndpointRepository,
  RotateWebhookSecretData,
  SealedHeaders,
  UpdateWebhookEndpointData,
  WebhookEndpointSummary,
};
