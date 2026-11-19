import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AppError } from "@/shared/errors/AppError";
import { parseBatchEnvelope } from "@/schemas/create-integration-deliveries-batch-schema";
import { spendExtraUnits } from "@/shared/integration/integration-units";

import { CreateIntegrationDeliveriesBatchUseCase } from "./create-integration-deliveries-batch-usecase";

class CreateIntegrationDeliveriesBatchController {
  handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const key = request.apiKey;

    // ensureApiKey ran first; this only keeps the type honest.
    if (!key)
      throw new AppError("Chave de API inválida.", 401, "INVALID_API_KEY");

    // The envelope first: 101 deliveries, or none, refuse the whole call
    // before a unit or a row is spent.
    const { deliveries } = parseBatchEnvelope(request.body);

    // N deliveries count N calls; the route's hooks counted one.
    await spendExtraUnits(request, reply, deliveries.length - 1);

    const results = await container
      .resolve(CreateIntegrationDeliveriesBatchUseCase)
      .execute({
        businessId: key.businessId,
        apiKeyId: key.id,
        apiKeyName: key.name,
        deliveries,
      });

    return reply.status(200).send({
      results,
      created: results.filter((result) => result.status === 201).length,
      replayed: results.filter((result) => result.status === 200).length,
      refused: results.filter((result) => result.status >= 400).length,
    });
  };
}

export { CreateIntegrationDeliveriesBatchController };
