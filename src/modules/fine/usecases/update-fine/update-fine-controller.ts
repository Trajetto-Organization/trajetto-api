import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateFineUseCase } from "./update-fine-usecase";

import { updateFineSchema } from "@/schemas/update-fine-schema";
import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { sendFineError } from "../fine-http-errors";

class UpdateFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { fineId } = updateDeleteFineSchema.parse(request.params);

    const fineData = updateFineSchema.parse(request.body);
    const updateFineUseCase = container.resolve(UpdateFineUseCase);

    try {
      await updateFineUseCase.execute(fineData, fineId, id, businessId);

      return reply.status(200).send({
        message: "Multa atualizada com sucesso!",
      });
    } catch (error) {
      // Date rules and FINE_NOT_FOUND are AppErrors: the error handler
      // answers them with their code.
      const handled = sendFineError(reply, error);

      if (handled) return handled;

      throw error;
    }
  }
}

export { UpdateFineController };
