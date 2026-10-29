import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReviewProofAuditUseCase } from "./review-proof-audit-usecase";

import {
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
} from "@/schemas/proof-audit-schema";

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

    // Refusals are AppErrors with their code (a user row gone is 404
    // USER_NOT_FOUND), answered by the global handler.
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
  }
}

export { ReviewProofAuditController };
