import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DecideOccurrenceAuthorizationUseCase } from "./decide-occurrence-authorization-usecase";
import { OccurrenceAlreadyDecidedError } from "./occurrence-authorization-errors";

import {
  decideOccurrenceAuthorizationSchema,
  occurrenceAuthorizationParamsSchema,
} from "./occurrence-authorization-schemas";

class DecideOccurrenceAuthorizationController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { occurrenceId, businessId } = occurrenceAuthorizationParamsSchema.parse(
      request.params,
    );
    const { decision, note } = decideOccurrenceAuthorizationSchema.parse(request.body);

    const useCase = container.resolve(DecideOccurrenceAuthorizationUseCase);

    try {
      const result = await useCase.execute({
        userId: id,
        businessId,
        occurrenceId,
        decision,
        note: note ?? null,
      });

      return reply.status(200).send({
        message:
          decision === "APPROVED"
            ? "Ocorrência autorizada. O motorista já foi avisado."
            : "Pedido negado. O motorista já foi avisado do motivo.",
        data: result,
      });
    } catch (error) {
      // The losing operator is told who decided what, not "try again".
      if (error instanceof OccurrenceAlreadyDecidedError) {
        return reply.status(409).send({
          code: error.code,
          message: error.message,
          decision: error.decision,
        });
      }

      throw error;
    }
  }
}

export { DecideOccurrenceAuthorizationController };
