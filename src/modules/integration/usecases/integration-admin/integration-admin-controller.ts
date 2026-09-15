import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";

import database from "@/../infra/database";
import { Prisma, WebhookDeliveryStatus } from "@prisma/client";

import {
  createApiKeySchema,
  integrationIdParamSchema,
  listWebhookDeliveriesSchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { generateApiKey } from "@/shared/integration/api-key-rules";
import { newWebhookSecret } from "@/shared/integration/webhook-signature";

import { REPLAY_WINDOW_DAYS } from "@/shared/integration/webhook-dispatch-rules";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import { sendAsNDJSON } from "@/config/stream-utils";

/**
 * The screens a customer's own administrator uses: issue a key, point a
 * webhook somewhere, look at what happened.
 *
 * Session-authenticated, unlike everything under `/integration/v1` — a person
 * in a browser, with a role and a tenant. Managing the credentials of an
 * integration through that integration's own credentials would mean a leaked
 * key can mint more keys.
 */
class IntegrationAdminController {
  private async scopedBusiness(
    request: FastifyRequest,
    businessId: string,
  ): Promise<string> {
    const user = await database.user.findUnique({
      where: { id: request.user.id },
      select: { id: true, role: true, businessId: true, driverId: true },
    });

    if (!user) {
      throw new AppError("Usuário não encontrado.", 400, "USER_NOT_FOUND");
    }

    assertTenantAccess(user as never, businessId);

    return businessId;
  }

  // ------------------------------------------------------------------ keys
  createApiKey = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const body = createApiKeySchema.parse(request.body);

    await this.scopedBusiness(request, businessId);

    const key = generateApiKey();

    const created = await database.apiKey.create({
      data: {
        name: body.name,
        prefix: key.prefix,
        token_hash: key.tokenHash,
        scopes: body.scopes,
        rate_limit_per_minute: body.rate_limit_per_minute,
        businessId,
      },
      select: { id: true, prefix: true },
    });

    // The token is in this response and nowhere else, ever. A key a dashboard
    // can re-display is a key in every screenshot and every support ticket.
    return reply.status(201).send({
      message:
        "Chave criada. Copie agora: ela não será exibida de novo.",
      data: { id: created.id, prefix: created.prefix, token: key.token },
    });
  };

  listApiKeys = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = request.query as { businessId?: string };

    const scoped = await this.scopedBusiness(
      request,
      businessId ?? (request.user as { businessId?: string }).businessId ?? "",
    );

    const data = await database.apiKey.findMany({
      where: { businessId: scoped },
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

    return reply
      .status(200)
      .send({ message: "Chaves obtidas com sucesso.", data });
  };

  revokeApiKey = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { id } = integrationIdParamSchema.parse(request.params);

    await this.scopedBusiness(request, businessId);

    // Revoked, not deleted. A key that made calls is part of the answer to
    // what happened, and deleting it would take the trail with it.
    const { count } = await database.apiKey.updateMany({
      where: { id, businessId, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    if (count === 0) {
      throw new AppError(
        "Chave não encontrada ou já revogada.",
        404,
        "API_KEY_NOT_FOUND",
      );
    }

    return reply.status(200).send({ message: "Chave revogada." });
  };

  // -------------------------------------------------------------- webhooks
  saveWebhookEndpoint = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const body = saveWebhookEndpointSchema.parse(request.body);

    await this.scopedBusiness(request, businessId);

    const params = request.params as { id?: string };

    if (params.id) {
      const { count } = await database.webhookEndpoint.updateMany({
        where: { id: params.id, businessId },
        data: {
          name: body.name,
          url: body.url,
          topics: body.topics,
          headers: (body.headers ?? null) as Prisma.InputJsonValue,
          is_active: body.is_active,

          // Editing an endpoint is somebody saying they fixed it. The failure
          // streak and our own switch-off go with that statement.
          disabled_at: null,
          consecutive_failures: 0,
        },
      });

      if (count === 0) {
        throw new AppError(
          "Endpoint não encontrado.",
          404,
          "WEBHOOK_ENDPOINT_NOT_FOUND",
        );
      }

      return reply.status(200).send({
        message: "Endpoint atualizado.",
        data: { id: params.id, secret: null },
      });
    }

    const secret = newWebhookSecret();

    const created = await database.webhookEndpoint.create({
      data: {
        name: body.name,
        url: body.url,
        secret,
        topics: body.topics,
        headers: (body.headers ?? null) as Prisma.InputJsonValue,
        is_active: body.is_active,
        businessId,
      },
      select: { id: true },
    });

    // Like the API key: shown once. A secret a dashboard can re-display is a
    // secret in every screenshot.
    return reply.status(201).send({
      message:
        "Endpoint criado. Copie o segredo agora: ele não será exibido de novo.",
      data: { id: created.id, secret },
    });
  };

  listWebhookEndpoints = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = request.query as { businessId?: string };

    const scoped = await this.scopedBusiness(
      request,
      businessId ?? (request.user as { businessId?: string }).businessId ?? "",
    );

    const data = await database.webhookEndpoint.findMany({
      where: { businessId: scoped },
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

    return reply
      .status(200)
      .send({ message: "Endpoints obtidos com sucesso.", data });
  };

  deleteWebhookEndpoint = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { id } = integrationIdParamSchema.parse(request.params);

    await this.scopedBusiness(request, businessId);

    const { count } = await database.webhookEndpoint.deleteMany({
      where: { id, businessId },
    });

    if (count === 0) {
      throw new AppError(
        "Endpoint não encontrado.",
        404,
        "WEBHOOK_ENDPOINT_NOT_FOUND",
      );
    }

    return reply.status(200).send({ message: "Endpoint removido." });
  };

  // --------------------------------------------------------------- monitor
  listWebhookDeliveries = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const query = request.query as z.infer<typeof listWebhookDeliveriesSchema>;

    const scoped = await this.scopedBusiness(
      request,
      query.businessId ??
        (request.user as { businessId?: string }).businessId ??
        "",
    );

    const where = {
      businessId: scoped,
      ...(query.status && { status: query.status as WebhookDeliveryStatus }),
      ...(query.endpointId && { endpointId: query.endpointId }),
    };

    const dataPromise = (async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [rows, total, counts, latencies] = await Promise.all([
        database.webhookDelivery.findMany({
          where,
          orderBy: { created_at: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: {
            id: true,
            topic: true,
            status: true,
            attempts: true,
            response_status: true,
            response_body: true,
            latency_ms: true,
            lastError: true,
            deliveredAt: true,

            // When we try again. A row sitting in "na fila" with no clue when
            // is a row somebody resends by hand, which is how a receiver gets
            // the same event twice.
            availableAt: true,

            created_at: true,
            endpoint: { select: { id: true, name: true, url: true } },
          },
        }),

        database.webhookDelivery.count({ where }),

        database.webhookDelivery.groupBy({
          by: ["status"],
          where: { businessId: scoped },
          _count: { _all: true },
        }),

        database.webhookDelivery.findMany({
          where: {
            businessId: scoped,
            status: "DELIVERED",
            deliveredAt: { gte: since },
            latency_ms: { not: null },
          },
          select: { latency_ms: true },
        }),
      ]);

      const sorted = latencies
        .map((entry) => entry.latency_ms ?? 0)
        .sort((left, right) => left - right);

      const countOf = (name: string) =>
        counts.find((entry) => entry.status === name)?._count._all ?? 0;

      return {
        data: rows,
        total,
        meta: {
          delivered: countOf("DELIVERED"),
          failed: countOf("FAILED"),
          pending: countOf("PENDING") + countOf("PROCESSING"),

          // p95 over the last day. The number an integrator is actually asked
          // about when their system feels slow.
          p95LatencyMs:
            sorted.length > 0
              ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
              : null,
        },
      };
    })();

    await sendAsNDJSON({
      reply,
      dataPromise,
      page: query.page,
      pageSize: query.pageSize,
    });
  };

  resendWebhookDelivery = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { id } = integrationIdParamSchema.parse(request.params);

    await this.scopedBusiness(request, businessId);

    const original = await database.webhookDelivery.findFirst({
      where: { id, businessId },
    });

    if (!original) {
      throw new AppError(
        "Entrega de webhook não encontrada.",
        404,
        "WEBHOOK_DELIVERY_NOT_FOUND",
      );
    }

    const windowStart = new Date(
      Date.now() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    // The replay window the contract promises. Past it the answer is a plain
    // sentence rather than a silent no-op: an operator pressing resend on a
    // two-month-old event has to know why nothing happened.
    if (original.created_at < windowStart) {
      throw new AppError(
        `Este evento tem mais de ${REPLAY_WINDOW_DAYS} dias e está fora da janela de reenvio.`,
        409,
        "OUTSIDE_REPLAY_WINDOW",
      );
    }

    // A NEW row rather than resetting the old one: the record of what was sent
    // and what their server answered the first time is the first thing
    // somebody asks for when a duplicate is reported.
    const resent = await database.webhookDelivery.create({
      data: {
        endpointId: original.endpointId,
        businessId,
        topic: original.topic,
        sourceEventId: original.sourceEventId,
        payload: original.payload as Prisma.InputJsonValue,

        // The same bytes and the same signature the first attempt carried.
        // Re-signing would produce a second event a receiver cannot match to
        // the first — which is exactly what somebody reporting a duplicate is
        // trying to work out.
        signed_body: original.signed_body,

        signature: original.signature,
        resent_from_id: original.id,
      },
      select: { id: true },
    });

    return reply.status(200).send({
      message: "Reenvio agendado.",
      data: { id: resent.id },
    });
  };
}

export { IntegrationAdminController };
