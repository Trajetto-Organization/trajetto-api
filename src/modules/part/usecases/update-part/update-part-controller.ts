import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdatePartUseCase } from "./update-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { updatePartSchema } from "@/schemas/update-part-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeletePartSchema } from "@/schemas/update-delete-part-schema";

class UpdatePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { partId } = updateDeletePartSchema.parse(request.params);

    const partData = updatePartSchema.parse(request.body);
    const updatePartUseCase = container.resolve(UpdatePartUseCase);

    try {
      await updatePartUseCase.execute(partData, partId, id, businessId);
      return reply
        .status(200)
        .send({ message: "Peça atualizada com sucesso!" });
    } catch (error) {
      // A missing or foreign part is a 404 PART_NOT_FOUND from the use
      // case; another company's supplier answers like a missing one.
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { UpdatePartController };
