import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateAILimitUseCase } from "./update-ai-limit-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateAILimitSchema } from "@/schemas/update-ai-limit-schema";

class UpdateAILimitController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { ai_analysis_limit } = updateAILimitSchema.parse(request.body);
    const updateAILimitUseCase = container.resolve(UpdateAILimitUseCase);

    const result = await updateAILimitUseCase.execute({
      userId: id,
      businessId,
      ai_analysis_limit,
    });

    return reply.status(200).send({
      message: "Limite de análise IA atualizado com sucesso!",
      data: result,
    });
  }
}

export { UpdateAILimitController };
