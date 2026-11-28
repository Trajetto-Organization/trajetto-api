import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AppError } from "@/shared/errors/AppError";
import { integrationIdParamSchema } from "@/schemas/integration-schema";
import { parseCancelIntegrationDeliveryBody } from "@/schemas/cancel-integration-delivery-schema";

import { REPLAYED_HEADER } from "../create-delivery/create-integration-delivery-controller";

import { CancelIntegrationDeliveryUseCase } from "./cancel-integration-delivery-usecase";
import { DeliveryNotCancellableError } from "./cancel-integration-delivery-errors";

class CancelIntegrationDeliveryController {
  handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const key = request.apiKey;

    // ensureApiKey ran first; this only keeps the type honest.
    if (!key)
      throw new AppError("Chave de API inválida.", 401, "INVALID_API_KEY");

    const { id } = integrationIdParamSchema.parse(request.params);
    const body = parseCancelIntegrationDeliveryBody(request.body);

    try {
      const result = await container
        .resolve(CancelIntegrationDeliveryUseCase)
        .execute({
          businessId: key.businessId,
          apiKeyId: key.id,
          apiKeyName: key.name,
          deliveryId: id,
          reason: body.reason,
        });

      // 200 either way: the delivery is cancelled. The header says whether
      // this call did it, for clients that log headers only.
      return reply
        .header(REPLAYED_HEADER, String(result.replayed))
        .status(200)
        .send(result.delivery);
    } catch (error) {
      if (!(error instanceof DeliveryNotCancellableError)) throw error;

      // The error handler sends `{ code, message }`; this 409 also says the
      // status in the way, which is what lets an ERP decide by itself.
      return reply.header("x-error-code", error.code).status(409).send({
        code: error.code,
        message: error.message,
        delivery_status: error.deliveryStatus,
      });
    }
  };
}

export { CancelIntegrationDeliveryController };
