import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { IIntegrationRepository } from "../../repositories/IIntegration-repository";

import {
  integrationIdParamSchema,
  integrationListSchema,
} from "@/schemas/integration-schema";

import { AppError } from "@/shared/errors/AppError";

/**
 * Everything an outside system reads.
 *
 * One controller for the five read routes, because they differ by one line
 * each and five files would be five places to forget the tenant scope. The
 * company comes from the API KEY and never from the request — a public API
 * that accepted a `businessId` parameter would be a public API where one
 * customer can ask for another's operation.
 */
class IntegrationReadController {
  private scope(request: FastifyRequest) {
    const key = request.apiKey;

    if (!key) {
      throw new AppError("Chave de API inválida.", 401, "INVALID_API_KEY");
    }

    // `status` is already one of its resource's enum values: each route
    // validates it against its own schema before this runs.
    const query = request.query as z.infer<typeof integrationListSchema> & {
      status?: string;
    };

    return {
      businessId: key.businessId,
      limit: query.limit,
      cursor: query.cursor,
      updated_since: query.updated_since,
      status: query.status,
    };
  }

  private repository(): IIntegrationRepository {
    return container.resolve<IIntegrationRepository>("IntegrationRepository");
  }

  listDeliveries = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.repository().listDeliveries(this.scope(request));

    return reply.status(200).send(result);
  };

  getDelivery = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = integrationIdParamSchema.parse(request.params);

    const found = await this.repository().findDelivery(
      request.apiKey!.businessId,
      id,
    );

    // Same 404 for "does not exist" and "belongs to another company": a
    // distinct answer would let one customer confirm another's ids.
    if (!found) {
      throw new AppError("Entrega não encontrada.", 404, "NOT_FOUND");
    }

    return reply.status(200).send(found);
  };

  listRoutes = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.repository().listRoutes(this.scope(request));

    return reply.status(200).send(result);
  };

  getRoute = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = integrationIdParamSchema.parse(request.params);

    const found = await this.repository().findRoute(
      request.apiKey!.businessId,
      id,
    );

    if (!found) {
      throw new AppError("Rota não encontrada.", 404, "NOT_FOUND");
    }

    return reply.status(200).send(found);
  };

  listEvents = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.repository().listEvents(this.scope(request));

    return reply.status(200).send(result);
  };
}

export { IntegrationReadController };
