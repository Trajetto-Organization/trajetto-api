import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestRecordAnalysisUseCase } from "./request-record-analysis-usecase";

import { aiAnalysisRecordSchema } from "@/schemas/ai-analysis-record-schema";

/**
 * Refusals are AppErrors with a code (AI_RECORD_NOT_FOUND 404,
 * AI_RECORD_WITHOUT_PHOTO 400, AI_NOT_ENABLED 409, AI_QUOTA_EXHAUSTED 409,
 * AI_NOT_COVERED 409, AI_PROVIDER_UNAVAILABLE 503), answered by the error handler with the code
 * in the body and in x-error-code.
 */
class RequestRecordAnalysisController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { recordType, recordId } = aiAnalysisRecordSchema.parse(
      request.params,
    );

    const result = await container
      .resolve(RequestRecordAnalysisUseCase)
      .execute({ principal: request.user, recordType, recordId });

    return reply.status(200).send(result);
  }
}

export { RequestRecordAnalysisController };
