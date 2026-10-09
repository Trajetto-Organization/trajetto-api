import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateStatusChangeReasonUseCase } from "./create-status-change-reason-usecase";

import { createStatusChangeReasonSchema } from "@/schemas/create-status-change-reason-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const reasonData = createStatusChangeReasonSchema.parse(request.body);

    const createStatusChangeReasonUseCase = container.resolve(
      CreateStatusChangeReasonUseCase,
    );

    await createStatusChangeReasonUseCase.execute(
      { ...reasonData, businessId },
      id,
    );

    return reply.status(201).send({ message: "Motivo criado com sucesso!" });
  }
}

export { CreateStatusChangeReasonController };
