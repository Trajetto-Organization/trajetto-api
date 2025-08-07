import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";

import { DeleteFineUseCase } from "./delete-fine-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class DeleteFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { fineId } = updateDeleteFineSchema.parse(request.params);

    const deleteFineUseCase = container.resolve(DeleteFineUseCase);

    try {
      await deleteFineUseCase.execute(fineId, id);

      return reply.status(200).send({
        message: "Multa deletada com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteFineController };
