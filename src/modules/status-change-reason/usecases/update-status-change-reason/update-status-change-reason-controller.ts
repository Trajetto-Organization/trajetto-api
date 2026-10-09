import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateStatusChangeReasonUseCase } from "./update-status-change-reason-usecase";

import { updateStatusChangeReasonSchema } from "@/schemas/update-status-change-reason-schema";
import { updateDeleteStatusChangeReasonSchema } from "@/schemas/update-delete-status-change-reason-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class UpdateStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { reasonId } = updateDeleteStatusChangeReasonSchema.parse(
      request.params,
    );

    const reasonData = updateStatusChangeReasonSchema.parse(request.body);

    const updateStatusChangeReasonUseCase = container.resolve(
      UpdateStatusChangeReasonUseCase,
    );

    await updateStatusChangeReasonUseCase.execute(
      reasonData,
      reasonId,
      businessId,
      id,
    );

    return reply
      .status(200)
      .send({ message: "Motivo atualizado com sucesso!" });
  }
}

export { UpdateStatusChangeReasonController };
