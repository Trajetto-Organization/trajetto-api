import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteStatusChangeReasonUseCase } from "./delete-status-change-reason-usecase";

import { updateDeleteStatusChangeReasonSchema } from "@/schemas/update-delete-status-change-reason-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class DeleteStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { reasonId } = updateDeleteStatusChangeReasonSchema.parse(
      request.params,
    );

    const deleteStatusChangeReasonUseCase = container.resolve(
      DeleteStatusChangeReasonUseCase,
    );

    await deleteStatusChangeReasonUseCase.execute(reasonId, businessId, id);

    return reply.status(200).send({ message: "Motivo excluído com sucesso!" });
  }
}

export { DeleteStatusChangeReasonController };
