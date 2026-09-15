import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateStatusChangeReasonUseCase } from "./create-status-change-reason-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { StatusChangeReasonNameAlreadyExistsError } from "../errors/status-change-reason-errors";

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

    try {
      await createStatusChangeReasonUseCase.execute(
        { ...reasonData, businessId },
        id,
      );

      return reply.status(201).send({ message: "Motivo criado com sucesso!" });
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof BusinessNotFoundError ||
        error instanceof StatusChangeReasonNameAlreadyExistsError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateStatusChangeReasonController };
