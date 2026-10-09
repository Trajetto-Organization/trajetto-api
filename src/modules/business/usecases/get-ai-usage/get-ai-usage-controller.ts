import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetAIUsageUseCase } from "./get-ai-usage-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class GetAIUsageController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const getAIUsageUseCase = container.resolve(GetAIUsageUseCase);

    // 404 with a code (decision 11.3). Another company's id answers the
    // same as one that does not exist, so an admin cannot probe for them.
    const result = await getAIUsageUseCase.execute({
      userId: id,
      businessId,
    });

    return reply.status(200).send({ data: result });
  }
}

export { GetAIUsageController };
