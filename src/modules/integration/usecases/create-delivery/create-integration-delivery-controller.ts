import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AppError } from "@/shared/errors/AppError";
import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

import { CreateIntegrationDeliveryUseCase } from "./create-integration-delivery-usecase";
import { pointsAtDelivery } from "./create-integration-delivery-errors";
import { readIntegrationIdempotencyKey } from "./integration-idempotency-key";

/**
 * Says a 200 is a replay without making the caller compare bodies. The
 * status already says it; the header is for clients that log headers only.
 */
const REPLAYED_HEADER = "idempotent-replayed";

class CreateIntegrationDeliveryController {
  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = request.apiKey;

    // ensureApiKey ran first; this only keeps the type honest.
    if (!key) throw new AppError("Chave de API inválida.", 401, "INVALID_API_KEY");

    // The key before the body: without it nothing below is safe to retry,
    // so it is the first thing an integrator should hear about.
    const idempotencyKey = readIntegrationIdempotencyKey(request.headers);
    const body = parseIntegrationDeliveryBody(request.body);

    try {
      const result = await container
        .resolve(CreateIntegrationDeliveryUseCase)
        .execute({
          businessId: key.businessId,
          apiKeyId: key.id,
          apiKeyName: key.name,
          idempotencyKey,
          body,
        });

      return reply
        .header(REPLAYED_HEADER, String(result.replayed))
        .status(result.replayed ? 200 : 201)
        .send(result.delivery);
    } catch (error) {
      if (!pointsAtDelivery(error)) throw error;

      // The error handler sends `{ code, message }`; this 409 also names the
      // delivery in the way, which is what lets an ERP reconcile by itself.
      return reply.header("x-error-code", error.code).status(409).send({
        code: error.code,
        message: error.message,
        delivery_id: error.deliveryId,
      });
    }
  };
}

export { CreateIntegrationDeliveryController, REPLAYED_HEADER };
