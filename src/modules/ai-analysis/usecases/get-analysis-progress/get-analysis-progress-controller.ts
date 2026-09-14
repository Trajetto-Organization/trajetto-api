import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetAnalysisProgressUseCase } from "./get-analysis-progress-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { aiAnalysisRecordSchema } from "@/schemas/ai-analysis-record-schema";

class GetAnalysisProgressController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { recordType, recordId } = aiAnalysisRecordSchema.parse(
      request.params,
    );

    const getAnalysisProgressUseCase = container.resolve(
      GetAnalysisProgressUseCase,
    );

    try {
      const result = await getAnalysisProgressUseCase.execute({
        userId: id,
        recordType,
        recordId,
      });

      return reply.status(200).send({ data: result });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetAnalysisProgressController };
