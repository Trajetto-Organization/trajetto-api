import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import "../../container";

import {
  createApiKeySchema,
  integrationIdParamSchema,
  listApiUsageSchema,
  listWebhookDeliveriesSchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { REPLAY_WINDOW_DAYS } from "@/shared/integration/webhook-dispatch-rules";
import { sendAsNDJSON } from "@/config/stream-utils";

import {
  CreateApiKeyUseCase,
  ListApiKeysUseCase,
  RevokeApiKeyUseCase,
} from "./api-key-usecases";
import {
  DeleteWebhookEndpointUseCase,
  ListWebhookEndpointsUseCase,
  ReactivateWebhookEndpointUseCase,
  RotateWebhookSecretUseCase,
  SaveWebhookEndpointUseCase,
} from "./webhook-endpoint-usecases";
import {
  ListApiUsageUseCase,
  ListWebhookDeliveriesUseCase,
  ResendWebhookDeliveryUseCase,
} from "./webhook-monitor-usecases";

/**
 * The screens a customer's own administrator uses: issue a key, point a
 * webhook somewhere, look at what happened.
 *
 * Session-authenticated, unlike everything under `/integration/v1`: managing
 * an integration's credentials through its own credentials would mean a
 * leaked key can mint more keys. The rules live in the use cases
 * (TEST-ARCH-1); this only maps HTTP to them.
 */
class IntegrationAdminController {
  /** The query's company for the MASTER, the person's own otherwise. */
  private queryBusiness(request: FastifyRequest, businessId?: string): string {
    return (
      businessId ??
      (request.user as { businessId?: string }).businessId ??
      ""
    );
  }

  // ------------------------------------------------------------------ keys
  createApiKey = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const body = createApiKeySchema.parse(request.body);

    const data = await container.resolve(CreateApiKeyUseCase).execute({
      userId: request.user.id,
      businessId,
      name: body.name,
      scopes: body.scopes,
      rate_limit_per_minute: body.rate_limit_per_minute,
    });

    // The token is in this response and nowhere else, ever.
    return reply.status(201).send({
      message: "Chave criada. Copie agora: ela não será exibida de novo.",
      data,
    });
  };

  listApiKeys = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = request.query as { businessId?: string };

    const data = await container
      .resolve(ListApiKeysUseCase)
      .execute(request.user.id, this.queryBusiness(request, businessId));

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

    await container
      .resolve(RevokeApiKeyUseCase)
      .execute(request.user.id, businessId, id);

    return reply.status(200).send({ message: "Chave revogada." });
  };

  // -------------------------------------------------------------- webhooks
  saveWebhookEndpoint = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const body = saveWebhookEndpointSchema.parse(request.body);
    const { id } = request.params as { id?: string };

    const saved = await container.resolve(SaveWebhookEndpointUseCase).execute({
      userId: request.user.id,
      businessId,
      id,
      name: body.name,
      url: body.url,
      topics: body.topics,
      headers: body.headers,
      is_active: body.is_active,
    });

    if (!saved.created) {
      return reply.status(200).send({
        message: "Endpoint atualizado.",
        data: { id: saved.id, secret: null },
      });
    }

    // Like the API key: the secret is shown once.
    return reply.status(201).send({
      message:
        "Endpoint criado. Copie o segredo agora: ele não será exibido de novo.",
      data: { id: saved.id, secret: saved.secret },
    });
  };

  reactivateWebhookEndpoint = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { id } = integrationIdParamSchema.parse(request.params);

    const result = await container
      .resolve(ReactivateWebhookEndpointUseCase)
      .execute(request.user.id, businessId, id);

    return reply.status(200).send(result);
  };

  rotateWebhookSecret = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { id } = integrationIdParamSchema.parse(request.params);

    const secret = await container
      .resolve(RotateWebhookSecretUseCase)
      .execute(request.user.id, businessId, id);

    // Like at creation: shown once, never again.
    return reply.status(200).send({
      message:
        "Novo segredo gerado. Copie agora: ele não será exibido de novo. O anterior continua válido por 24 horas.",
      data: { id, secret },
    });
  };

  listWebhookEndpoints = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { businessId } = request.query as { businessId?: string };

    const data = await container
      .resolve(ListWebhookEndpointsUseCase)
      .execute(request.user.id, this.queryBusiness(request, businessId));

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

    await container
      .resolve(DeleteWebhookEndpointUseCase)
      .execute(request.user.id, businessId, id);

    return reply.status(200).send({ message: "Endpoint removido." });
  };

  // --------------------------------------------------------------- monitor
  listApiUsage = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    // Already validated and transformed by the route's querystring schema;
    // parsing it again read `days` — a number by now — as a string and
    // answered 400 on every call.
    const query = request.query as ReturnType<typeof listApiUsageSchema.parse>;

    const data = await container.resolve(ListApiUsageUseCase).execute({
      userId: request.user.id,
      businessId: this.queryBusiness(request, query.businessId),
      days: query.days,
      apiKeyId: query.apiKeyId,
    });

    return reply.status(200).send({ message: "Uso obtido com sucesso.", data });
  };

  listWebhookDeliveries = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const query = request.query as ReturnType<
      typeof listWebhookDeliveriesSchema.parse
    >;

    await sendAsNDJSON({
      reply,
      dataPromise: container.resolve(ListWebhookDeliveriesUseCase).execute({
        userId: request.user.id,
        businessId: this.queryBusiness(request, query.businessId),
        page: query.page,
        pageSize: query.pageSize,
        status: query.status,
        window: query.window,
        endpointId: query.endpointId,
      }),
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

    const resent = await container
      .resolve(ResendWebhookDeliveryUseCase)
      .execute(request.user.id, businessId, id);

    return reply.status(200).send({
      message: resent.held
        ? `Reenvio agendado, mas o endpoint está pausado ou desligado: o evento será enviado quando ele for reativado (em até ${REPLAY_WINDOW_DAYS} dias).`
        : "Reenvio agendado.",
      data: { id: resent.id },
    });
  };
}

export { IntegrationAdminController };
