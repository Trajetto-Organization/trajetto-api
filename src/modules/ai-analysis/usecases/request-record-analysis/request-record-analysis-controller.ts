import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestRecordAnalysisUseCase } from "./request-record-analysis-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { aiAnalysisRecordSchema } from "@/schemas/ai-analysis-record-schema";

class RequestRecordAnalysisController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { recordType, recordId } = aiAnalysisRecordSchema.parse(
      request.params,
    );

    const requestRecordAnalysisUseCase = container.resolve(
      RequestRecordAnalysisUseCase,
    );

    try {
      const result = await requestRecordAnalysisUseCase.execute({
        userId: id,
        recordType,
        recordId,
      });

      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { RequestRecordAnalysisController };
