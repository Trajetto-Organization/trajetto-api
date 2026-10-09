import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { DeleteFineUseCase } from "./delete-fine-usecase";

import { sendFineError } from "../fine-http-errors";

class DeleteFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const { fineId } = updateDeleteFineSchema.parse(request.params);
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const deleteFineUseCase = container.resolve(DeleteFineUseCase);

    try {
      await deleteFineUseCase.execute(fineId, id, businessId);

      return reply.status(200).send({
        message: "Multa deletada com sucesso!",
      });
    } catch (error) {
      // FineNotFoundError is an AppError: the error handler answers its 404
      // with the code.
      const handled = sendFineError(reply, error);

      if (handled) return handled;

      throw error;
    }
  }
}

export { DeleteFineController };
