import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetAnalysisProgressUseCase } from "./get-analysis-progress-usecase";

import { aiAnalysisRecordSchema } from "@/schemas/ai-analysis-record-schema";

class GetAnalysisProgressController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { recordType, recordId } = aiAnalysisRecordSchema.parse(
      request.params,
    );

    const result = await container
      .resolve(GetAnalysisProgressUseCase)
      .execute({ principal: request.user, recordType, recordId });

    return reply.status(200).send({ data: result });
  }
}

export { GetAnalysisProgressController };
