import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetAIUsageUseCase } from "./get-ai-usage-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class GetAIUsageController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const getAIUsageUseCase = container.resolve(GetAIUsageUseCase);

    try {
      const result = await getAIUsageUseCase.execute({
        userId: id,
        businessId,
      });

      return reply.status(200).send({ data: result });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetAIUsageController };
