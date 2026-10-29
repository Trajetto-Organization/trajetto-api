import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type {
  CreateWebhookEndpointData,
  IWebhookEndpointRepository,
  RotateWebhookSecretData,
  UpdateWebhookEndpointData,
  WebhookEndpointSummary,
} from "../IWebhook-endpoint-repository";

interface InMemoryWebhookEndpoint extends WebhookEndpointSummary {
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  headers: Prisma.InputJsonValue | null;
  businessId: string;
  updated_at: Date;
}

/**
 * The twin of WebhookEndpointRepository: the quota counts paused endpoints
 * too, every read and write is scoped by company, an edit clears the
 * breaker, and the list is newest first — as the database does.
 */
class InMemoryWebhookEndpointRepository implements IWebhookEndpointRepository {
  constructor(public endpoints: InMemoryWebhookEndpoint[] = []) {}

  private owned(id: string, businessId: string) {
    return this.endpoints.find(
      (endpoint) => endpoint.id === id && endpoint.businessId === businessId,
    );
  }

  async createWithinQuota(
    businessId: string,
    data: CreateWebhookEndpointData,
    max: number,
  ): Promise<{ id: string } | null> {
    const registered = this.endpoints.filter(
      (endpoint) => endpoint.businessId === businessId,
    ).length;

    if (registered >= max) return null;

    const now = new Date();
    const endpoint: InMemoryWebhookEndpoint = {
      id: randomUUID(),
      name: data.name,
      url: data.url,
      secret: data.secret,
      previous_secret: null,
      previous_secret_expires_at: null,
      topics: [...data.topics],
      headers: data.headers,
      is_active: data.is_active,
      disabled_at: null,
      consecutive_failures: 0,
      businessId,
      created_at: now,
      updated_at: now,
    };

    this.endpoints.push(endpoint);

    return { id: endpoint.id };
  }

  async update(
    id: string,
    businessId: string,
    data: UpdateWebhookEndpointData,
  ): Promise<boolean> {
    const endpoint = this.owned(id, businessId);

    if (!endpoint) return false;

    endpoint.name = data.name;
    endpoint.url = data.url;
    endpoint.topics = [...data.topics];

    if (data.headers !== undefined) endpoint.headers = data.headers;

    endpoint.is_active = data.is_active;
    endpoint.disabled_at = null;
    endpoint.consecutive_failures = 0;
    endpoint.updated_at = new Date();

    return true;
  }

  async find(
    id: string,
    businessId: string,
  ): Promise<{ id: string; name: string; is_active: boolean } | null> {
    const endpoint = this.owned(id, businessId);

    return endpoint
      ? { id: endpoint.id, name: endpoint.name, is_active: endpoint.is_active }
      : null;
  }

  async resetBreaker(id: string, businessId: string): Promise<boolean> {
    const endpoint = this.owned(id, businessId);

    if (!endpoint || endpoint.disabled_at === null) return false;

    endpoint.disabled_at = null;
    endpoint.consecutive_failures = 0;
    endpoint.updated_at = new Date();

    return true;
  }

  async rotateSecret(
    id: string,
    businessId: string,
    data: RotateWebhookSecretData,
  ): Promise<boolean> {
    const endpoint = this.owned(id, businessId);

    if (!endpoint) return false;

    endpoint.previous_secret = data.previousOf(endpoint.secret);
    endpoint.previous_secret_expires_at = data.previousExpiresAt;
    endpoint.secret = data.secret;
    endpoint.updated_at = new Date();

    return true;
  }

  async listByBusiness(businessId: string): Promise<WebhookEndpointSummary[]> {
    return this.endpoints
      .filter((endpoint) => endpoint.businessId === businessId)
      .sort(
        (left, right) => right.created_at.getTime() - left.created_at.getTime(),
      )
      .map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        url: endpoint.url,
        topics: [...endpoint.topics],
        is_active: endpoint.is_active,
        disabled_at: endpoint.disabled_at,
        consecutive_failures: endpoint.consecutive_failures,
        created_at: endpoint.created_at,
      }));
  }

  async delete(id: string, businessId: string): Promise<boolean> {
    const before = this.endpoints.length;

    this.endpoints = this.endpoints.filter(
      (endpoint) => !(endpoint.id === id && endpoint.businessId === businessId),
    );

    return this.endpoints.length < before;
  }
}

export { InMemoryWebhookEndpointRepository };
export type { InMemoryWebhookEndpoint };
