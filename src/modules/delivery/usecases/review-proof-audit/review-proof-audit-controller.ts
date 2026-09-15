import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReviewProofAuditUseCase } from "./review-proof-audit-usecase";

import {
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
} from "@/schemas/proof-audit-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ReviewProofAuditController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { auditId, businessId } = reviewProofAuditParamsSchema.parse(
      request.params,
    );

    const { status, rejection_reason } = reviewProofAuditSchema.parse(
      request.body,
    );

    const useCase = container.resolve(ReviewProofAuditUseCase);

    try {
      await useCase.execute({
        userId: id,
        businessId,
        auditId,
        status,
        rejection_reason,
      });

      return reply.status(200).send({
        message:
          status === "APPROVED"
            ? "Comprovante aprovado."
            : "Comprovante rejeitado e ocorrência registrada.",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ReviewProofAuditController };
