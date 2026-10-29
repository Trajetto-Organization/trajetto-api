import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeletePartUseCase } from "./delete-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeletePartSchema } from "@/schemas/update-delete-part-schema";

class DeletePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { partId } = updateDeletePartSchema.parse(request.params);

    const deletePartUseCase = container.resolve(DeletePartUseCase);

    // Part errors are AppErrors (404 for a missing or foreign part, 409 in
    // use): the global handler answers them.
    try {
      await deletePartUseCase.execute(partId, id, businessId);
      return reply.status(200).send({ message: "Peça deletada com sucesso!" });
    } catch (error) {
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { DeletePartController };
