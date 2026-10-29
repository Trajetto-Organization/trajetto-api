import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type {
  CreateWebhookEndpointData,
  IWebhookEndpointRepository,
  RotateWebhookSecretData,
  SealedHeaders,
  UpdateWebhookEndpointData,
  WebhookEndpointSummary,
} from "./IWebhook-endpoint-repository";

function headersValue(headers: SealedHeaders) {
  return headers === null ? Prisma.DbNull : headers;
}

class WebhookEndpointRepository implements IWebhookEndpointRepository {
  constructor(private prisma = database) {}

  async createWithinQuota(
    businessId: string,
    data: CreateWebhookEndpointData,
    max: number,
  ): Promise<{ id: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      // The same advisory lock the API keys use, and for the same reason
      // not FOR UPDATE on the business row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`webhook-endpoint-quota:${businessId}`}, 0))`;

      // Paused endpoints count: they are one switch away from receiving.
      const registered = await tx.webhookEndpoint.count({
        where: { businessId },
      });

      if (registered >= max) return null;

      return tx.webhookEndpoint.create({
        data: {
          name: data.name,
          url: data.url,
          secret: data.secret,
          topics: data.topics,
          headers: headersValue(data.headers),
          is_active: data.is_active,
          businessId,
        },
        select: { id: true },
      });
    });
  }

  async update(
    id: string,
    businessId: string,
    data: UpdateWebhookEndpointData,
  ): Promise<boolean> {
    const { count } = await this.prisma.webhookEndpoint.updateMany({
      where: { id, businessId },
      data: {
        name: data.name,
        url: data.url,
        topics: data.topics,

        // Omitted keeps what is stored: the web form has no headers field,
        // and every save through it used to wipe the Authorization an
        // integrator set through the API. Only an explicit null clears.
        ...(data.headers !== undefined && {
          headers: headersValue(data.headers),
        }),

        is_active: data.is_active,
        disabled_at: null,
        consecutive_failures: 0,
      },
    });

    return count > 0;
  }

  async find(
    id: string,
    businessId: string,
  ): Promise<{ id: string; name: string; is_active: boolean } | null> {
    return this.prisma.webhookEndpoint.findFirst({
      where: { id, businessId },
      select: { id: true, name: true, is_active: true },
    });
  }

  async resetBreaker(id: string, businessId: string): Promise<boolean> {
    // Only a switched-off endpoint changes: a second click finds nothing.
    const { count } = await this.prisma.webhookEndpoint.updateMany({
      where: { id, businessId, disabled_at: { not: null } },
      data: { disabled_at: null, consecutive_failures: 0 },
    });

    return count > 0;
  }

  async rotateSecret(
    id: string,
    businessId: string,
    data: RotateWebhookSecretData,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Locked, so two rotations in the same instant cannot both keep the
      // same "previous" and lose the secret the receiver actually holds.
      const [current] = await tx.$queryRaw<Array<{ secret: string }>>`
        SELECT "secret" FROM "webhook_endpoint"
        WHERE "id" = ${id} AND "businessId" = ${businessId}
        FOR UPDATE
      `;

      if (!current) return false;

      await tx.webhookEndpoint.update({
        where: { id },
        data: {
          secret: data.secret,
          previous_secret: data.previousOf(current.secret),
          previous_secret_expires_at: data.previousExpiresAt,
        },
      });

      return true;
    });
  }

  async listByBusiness(businessId: string): Promise<WebhookEndpointSummary[]> {
    return this.prisma.webhookEndpoint.findMany({
      where: { businessId },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        name: true,
        url: true,
        topics: true,
        is_active: true,
        disabled_at: true,
        consecutive_failures: true,
        created_at: true,
      },
    });
  }

  async delete(id: string, businessId: string): Promise<boolean> {
    const { count } = await this.prisma.webhookEndpoint.deleteMany({
      where: { id, businessId },
    });

    return count > 0;
  }
}

export { WebhookEndpointRepository };
